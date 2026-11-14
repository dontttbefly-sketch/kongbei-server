'use strict';
// SaaS 业务测试：请求包装器（双轨）、口令提取、激活码核销、运营管理
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const t = require('./tenant.js');
const s = require('./saas.js');

process.env.SAAS_SECRET = 'test-master-secret-0123456789';
process.env.SAAS_ADMIN_TOKEN = 'admin-token-test';

function freshStorage() {
  t.setStorage(t.memoryStorage());
  t.clearResolveCache();
}

async function makeTenant({ expireAt = Date.now() + 86400_000 } = {}) {
  const id = t.newUserId();
  const access = t.newToken(id);
  const account = t.newToken(id);
  const rec = {
    id,
    createdAt: Date.now(),
    boundAt: Date.now(),
    expireAt,
    appId: `cli_${id}`,
    secretEnc: t.encryptText('app-secret'),
    accessEnc: t.encryptText(access),
    accountEnc: t.encryptText(account),
    baseToken: 'bascn_test',
    tableId: 'tbl_test',
    tableUrl: 'https://feishu.cn/base/bascn_test',
  };
  await t.saveTenant(rec);
  return { rec, access, account };
}

beforeEach(() => {
  freshStorage();
  delete process.env.SAAS_MODE;
});

// ── withTenant ────────────────────────────────────────
test('withTenant：开源模式（无 SAAS_MODE）原样透传，不碰存储', async () => {
  let called = 0;
  const h = s.withTenant(async (ev) => {
    called++;
    return { statusCode: 200, body: JSON.stringify({ ok: true, echo: ev.body }) };
  });
  const out = await h({ method: 'POST', body: '{"token":"whatever"}', headers: {} });
  assert.strictEqual(called, 1);
  assert.strictEqual(out.statusCode, 200);
});

test('withTenant：SaaS 模式下缺口令 → 401', async () => {
  process.env.SAAS_MODE = '1';
  const h = s.withTenant(async () => ({ statusCode: 200, body: '{}' }), { write: true });
  const out = await h({ method: 'POST', body: '{}', headers: {} });
  assert.strictEqual(out.statusCode, 401);
});

test('withTenant：SaaS 模式下错误口令 → 401（不进入业务）', async () => {
  process.env.SAAS_MODE = '1';
  await makeTenant();
  let called = 0;
  const h = s.withTenant(async () => {
    called++;
    return { statusCode: 200, body: '{}' };
  });
  const out = await h({ method: 'POST', body: JSON.stringify({ token: 'u0000000000.wrongwrongwrongwrong' }), headers: {} });
  assert.strictEqual(out.statusCode, 401);
  assert.strictEqual(called, 0);
});

test('withTenant：有效口令 → 注入租户上下文，业务内 env 读到租户配置', async () => {
  process.env.SAAS_MODE = '1';
  const { access, rec } = await makeTenant();
  const h = s.withTenant(async () => {
    const cfg = {
      appId: t.configOf('FEISHU_APP_ID'),
      base: t.configOf('BASE_TOKEN'),
      apiToken: t.configOf('API_TOKEN'),
      cacheKey: t.cacheKey(),
    };
    return { statusCode: 200, body: JSON.stringify(cfg) };
  });
  const out = await h({ method: 'POST', body: JSON.stringify({ token: access }), headers: {} });
  assert.strictEqual(out.statusCode, 200);
  const cfg = JSON.parse(out.body);
  assert.strictEqual(cfg.appId, rec.appId);
  assert.strictEqual(cfg.base, 'bascn_test');
  assert.strictEqual(cfg.apiToken, access);
  assert.strictEqual(cfg.cacheKey, rec.id);
});

test('withTenant：会员过期 → 读接口放行、写接口 402', async () => {
  process.env.SAAS_MODE = '1';
  const { access } = await makeTenant({ expireAt: Date.now() - 1000 });
  const read = s.withTenant(async () => ({ statusCode: 200, body: '{"ok":true}' }));
  const write = s.withTenant(async () => ({ statusCode: 200, body: '{"ok":true}' }), { write: true });
  const ev = { method: 'POST', body: JSON.stringify({ token: access }), headers: {} };
  assert.strictEqual((await read(ev)).statusCode, 200);
  const w = await write(ev);
  assert.strictEqual(w.statusCode, 402);
  assert.strictEqual(JSON.parse(w.body).error, 'membership_expired');
});

test('免费模式（SAAS_FREE=1）：过期的也能记账、改账；关掉就恢复会员制', async () => {
  process.env.SAAS_MODE = '1';
  const { access } = await makeTenant({ expireAt: Date.now() - 1000 });
  const write = s.withTenant(async () => ({ statusCode: 200, body: '{"ok":true}' }), { write: true });
  const ev = { method: 'POST', body: JSON.stringify({ token: access }), headers: {} };
  process.env.SAAS_FREE = '1';
  try {
    assert.strictEqual((await write(ev)).statusCode, 200);
    assert.strictEqual(t.memberActive({ expireAt: 0 }), true);
  } finally {
    delete process.env.SAAS_FREE;
  }
  t.clearResolveCache();
  assert.strictEqual((await write(ev)).statusCode, 402);
});

test('免费模式：到期提醒一条都不发', async () => {
  process.env.SAAS_MODE = '1';
  process.env.SAAS_FREE = '1';
  const secret = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const out = await s.cronRemind({});
    assert.strictEqual(out.skipped, 'free');
  } finally {
    delete process.env.SAAS_FREE;
    if (secret !== undefined) process.env.CRON_SECRET = secret;
  }
});

test('withTenant：OPTIONS / GET 直接透传（预检、健康检查）', async () => {
  process.env.SAAS_MODE = '1';
  let n = 0;
  const h = s.withTenant(async () => {
    n++;
    return { statusCode: 200, body: '{}' };
  });
  await h({ method: 'OPTIONS', headers: {} });
  await h({ method: 'GET', headers: {} });
  await h({ requestContext: { http: { method: 'GET' } }, headers: {} });
  assert.strictEqual(n, 3);
});

// ── 运营方自用兼容（一份部署两用：线上服务 + 自己的账本） ──
test('withTenant：SaaS 模式下，运营方自用口令（环境变量里那两串）仍可通行', async () => {
  process.env.SAAS_MODE = '1';
  process.env.API_TOKEN = 'self-view-token';
  process.env.ACCOUNTING_SECRET = 'self-account-token';
  try {
    let called = 0;
    const h = s.withTenant(async () => {
      called++;
      // 自用模式下没有租户上下文 → configOf 自动回退环境变量（这就是「一份部署两用」的实现基础）
      return { statusCode: 200, body: JSON.stringify({ ok: true, base: t.configOf('BASE_TOKEN') }) };
    });
    assert.strictEqual((await h({ method: 'POST', body: JSON.stringify({ token: 'self-view-token' }), headers: {} })).statusCode, 200);
    assert.strictEqual((await h({ method: 'POST', body: JSON.stringify({ token: 'self-account-token' }), headers: {} })).statusCode, 200);
    // 乱猜的口令依然 401（自用放行是精确匹配，不是「任意口令都过」）
    assert.strictEqual((await h({ method: 'POST', body: JSON.stringify({ token: 'guessing-token' }), headers: {} })).statusCode, 401);
    assert.strictEqual(called, 2);
  } finally {
    delete process.env.API_TOKEN;
    delete process.env.ACCOUNTING_SECRET;
  }
});

test('status：运营方自用口令 → self:true（前端不显示会员区块）', async () => {
  process.env.SAAS_MODE = '1';
  process.env.API_TOKEN = 'self-view-token';
  try {
    const out = await s.status({ token: 'self-view-token' });
    assert.strictEqual(out.self, true);
    assert.strictEqual(out.active, true);
  } finally {
    delete process.env.API_TOKEN;
  }
});

// ── extractToken ──────────────────────────────────────
test('extractToken：五种来源都能取到', () => {
  assert.strictEqual(s.extractToken({ headers: { authorization: 'Bearer tok1' }, body: '' }, { authorization: 'Bearer tok1' }), 'tok1');
  assert.strictEqual(s.extractToken({ headers: {}, body: '' }, { 'x-accounting-secret': 'tok2' }), 'tok2');
  assert.strictEqual(s.extractToken({ headers: {}, body: JSON.stringify({ token: 'tok3' }) }, {}), 'tok3');
  assert.strictEqual(s.extractToken({ headers: {}, body: JSON.stringify({ secret: 'tok4' }) }, {}), 'tok4');
  assert.strictEqual(s.extractToken({ headers: {}, body: '', queryParameters: { key: 'tok5' } }, {}), 'tok5');
});

test('extractToken：base64 编码的 body 也能解析', () => {
  const raw = Buffer.from(JSON.stringify({ token: 'tok-b64' })).toString('base64');
  assert.strictEqual(s.extractToken({ headers: {}, body: raw, isBase64Encoded: true }, {}), 'tok-b64');
});

test('extractToken：坏 body 不抛错，返回空', () => {
  assert.strictEqual(s.extractToken({ headers: {}, body: '{oops' }, {}), '');
  assert.strictEqual(s.extractToken({ headers: {}, body: 'null' }, {}), '');
  assert.strictEqual(s.extractToken({ headers: {}, body: '[1,2]' }, {}), '');
});

// ── status ────────────────────────────────────────────
test('status：开源版回答 saas:false；线上版无口令回答 bound:false', async () => {
  const out1 = await s.status({});
  assert.strictEqual(out1.saas, false);

  process.env.SAAS_MODE = '1';
  const out2 = await s.status({});
  assert.strictEqual(out2.saas, true);
  assert.strictEqual(out2.bound, false);
});

test('status：有效口令返回会员信息', async () => {
  process.env.SAAS_MODE = '1';
  const { access, rec } = await makeTenant();
  const out = await s.status({ token: access });
  assert.strictEqual(out.bound, true);
  assert.strictEqual(out.userId, rec.id);
  assert.strictEqual(out.active, true);
  assert.strictEqual(out.tableUrl, rec.tableUrl);
});

// ── activate ──────────────────────────────────────────
test('activate：核销成功 → 会员延长；同一个码再用 → 409', async () => {
  process.env.SAAS_MODE = '1';
  const { access, rec } = await makeTenant({ expireAt: 0 });
  const code = t.newCode();
  await t.storage().set(t.codeKey(code), JSON.stringify({ days: 365, usedBy: null, createdAt: Date.now() }));
  await t.storage().sadd(t.CODES_SET, code);

  const out = await s.activate({ token: access, code: code.toLowerCase() }); // 大小写不敏感
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.days, 365);
  const after = await t.loadTenant(rec.id);
  assert.ok(after.expireAt > Date.now() + 360 * 86400_000);

  await assert.rejects(() => s.activate({ token: access, code }), (e) => e.status === 409);
});

test('activate：未到期续期 → 顺延而不是覆盖', async () => {
  process.env.SAAS_MODE = '1';
  const future = Date.now() + 10 * 86400_000;
  const { access, rec } = await makeTenant({ expireAt: future });
  const code = t.newCode();
  await t.storage().set(t.codeKey(code), JSON.stringify({ days: 365, usedBy: null }));
  await t.storage().sadd(t.CODES_SET, code);
  const out = await s.activate({ token: access, code });
  assert.ok(out.expireAt > future + 360 * 86400_000, '应在原到期时间上顺延');
  const after = await t.loadTenant(rec.id);
  assert.ok(after.expireAt > future + 360 * 86400_000);
});

test('activate：不存在的码 → 404；口令不对 → 401', async () => {
  process.env.SAAS_MODE = '1';
  const { access } = await makeTenant();
  await assert.rejects(() => s.activate({ token: access, code: 'KB-AAAA-BBBB-CCCC' }), (e) => e.status === 404);
  await assert.rejects(() => s.activate({ token: 'u0000000000.' + 'x'.repeat(24), code: 'KB-AAAA-BBBB-CCCC' }), (e) => e.status === 401);
});

// ── admin ─────────────────────────────────────────────
test('admin：口令不对 → 401', async () => {
  await assert.rejects(() => s.admin({ action: 'list' }, { 'x-admin-token': 'wrong' }), (e) => e.status === 401);
});

test('admin：生成激活码并落库', async () => {
  const out = await s.admin({ action: 'gencode', count: 3, days: 365 }, { 'x-admin-token': 'admin-token-test' });
  assert.strictEqual(out.codes.length, 3);
  const stored = await t.storage().get(t.codeKey(out.codes[0]));
  assert.ok(JSON.parse(stored).days === 365);
  const list = await s.admin({ action: 'codes' }, { 'x-admin-token': 'admin-token-test' });
  assert.strictEqual(list.codes.length, 3);
});

test('admin：列出用户 / 手动开通 / 查看（不带口令和密钥）', async () => {
  const { rec, access } = await makeTenant({ expireAt: 0 });
  const h = { 'x-admin-token': 'admin-token-test' };

  const list = await s.admin({ action: 'list' }, h);
  assert.strictEqual(list.total, 1);
  assert.strictEqual(list.users[0].active, false);
  assert.strictEqual(list.users[0].baseToken, rec.baseToken, '能按账本网址对上用户');

  const g = await s.admin({ action: 'grant', userId: rec.id, days: 30 }, h);
  assert.ok(g.expireAt > Date.now() + 29 * 86400_000);

  const show = await s.admin({ action: 'show', userId: rec.id }, h);
  assert.strictEqual(show.user.id, rec.id);
  assert.strictEqual(show.user.active, true);
  const text = JSON.stringify(show);
  assert.ok(!('accessToken' in show) && !('accountingToken' in show), '查看不给口令');
  assert.ok(!text.includes(access), '口令明文不能出现');
  assert.ok(!('secretEnc' in show.user) && !('accessEnc' in show.user) && !('accountEnc' in show.user), '密文也不往外给');
});

test('admin：reset 发一对新口令，旧口令随即作废', async () => {
  process.env.SAAS_MODE = '1';
  const { rec, access, account } = await makeTenant();
  const h = { 'x-admin-token': 'admin-token-test' };
  assert.ok(await t.resolveTenant(access)); // 先进缓存：重置后缓存也要清掉

  const out = await s.admin({ action: 'reset', userId: rec.id }, h);
  assert.strictEqual(out.userId, rec.id);
  assert.notStrictEqual(out.accessToken, access);
  assert.strictEqual(await t.resolveTenant(access), null, '旧看板口令作废');
  assert.strictEqual(await t.resolveTenant(account), null, '旧记账口令作废');
  const ctx = await t.resolveTenant(out.accessToken);
  assert.strictEqual(ctx.tenant.id, rec.id, '还是同一个用户');
  assert.strictEqual(ctx.config.ACCOUNTING_SECRET, out.accountingToken);
  await assert.rejects(() => s.admin({ action: 'reset', userId: 'u0000000000' }, h), (e) => e.status === 404);
});

// ── 换口令 ────────────────────────────────────────────
test('rotate：凭看板口令换一对新的；账本、会员、用户 ID 都不动', async () => {
  process.env.SAAS_MODE = '1';
  const expireAt = Date.now() + 200 * 86400_000;
  const { rec, access, account } = await makeTenant({ expireAt });

  const out = await s.rotate({ token: access });
  assert.ok(out.accessToken.startsWith(`${rec.id}.`));
  assert.ok(out.accountingToken.startsWith(`${rec.id}.`));
  assert.notStrictEqual(out.accessToken, access);
  assert.notStrictEqual(out.accountingToken, account);
  assert.strictEqual(await t.resolveTenant(access), null);
  assert.strictEqual(await t.resolveTenant(account), null);

  const after = await t.loadTenant(rec.id);
  assert.strictEqual(after.expireAt, expireAt);
  assert.strictEqual(after.baseToken, rec.baseToken);
  assert.strictEqual(after.tableId, rec.tableId);
  assert.strictEqual(after.appId, rec.appId);
  assert.ok(after.rotatedAt > 0);
});

test('rotate：记账口令、错口令都换不了；开源版直接拒绝', async () => {
  process.env.SAAS_MODE = '1';
  const { access, account } = await makeTenant();
  await assert.rejects(() => s.rotate({ token: account }), (e) => e.status === 401, '记账口令跟着快捷指令到处走，不能拿它换整套口令');
  await assert.rejects(() => s.rotate({ token: 'u0000000000.' + 'x'.repeat(24) }), (e) => e.status === 401);
  assert.ok(await t.resolveTenant(access), '失败的尝试不影响原口令');
  delete process.env.SAAS_MODE;
  await assert.rejects(() => s.rotate({ token: access }), (e) => e.status === 400);
});

test('activate：按存储里最新的记录续期，不拿一分钟前的缓存回写', async () => {
  process.env.SAAS_MODE = '1';
  const { rec, access } = await makeTenant({ expireAt: Date.now() + 10 * 86400_000 });
  await t.resolveTenant(access); // 本实例缓存住旧记录
  // 另一个实例刚给他加了 30 天（这个实例的缓存不知道）
  const other = await t.loadTenant(rec.id);
  other.expireAt += 30 * 86400_000;
  await t.saveTenant(other);

  const code = t.newCode();
  await t.storage().set(t.codeKey(code), JSON.stringify({ days: 365, usedBy: null }));
  const out = await s.activate({ token: access, code });
  assert.strictEqual(out.expireAt, other.expireAt + 365 * 86400_000, '应在最新的到期时间上顺延');
});

// ── 限流、会话过期 ────────────────────────────────────
test('限流：同一个 IP 十分钟内一键创建超过 10 次 → 429；别的 IP 不受影响', async () => {
  const origBegin = reg.begin;
  reg.begin = async () => ({ url: 'https://x', deviceCode: 'dc', intervalMs: 3000, expiresInMs: 600000 });
  try {
    const ip = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' };
    for (let i = 0; i < 10; i++) await s.createAppBegin(ip);
    await assert.rejects(() => s.createAppBegin(ip), (e) => e.status === 429);
    const out = await s.createAppBegin({ 'x-real-ip': '198.51.100.2' });
    assert.strictEqual(out.ok, true);
  } finally {
    reg.begin = origBegin;
  }
});

test('限流：手动绑定格式不对不算次数（不打飞书），超过 10 次才 429', async () => {
  const ip = { 'x-real-ip': '203.0.113.9' };
  for (let i = 0; i < 12; i++) {
    await assert.rejects(() => s.bind({ appId: 'bad', appSecret: 'x'.repeat(30) }, ip), (e) => e.status === 400);
  }
  const restore = mockFeishuFetch();
  try {
    for (let i = 0; i < 10; i++) await s.bind({ appId: 'cli_1234567890abcd', appSecret: 'x'.repeat(32) }, ip);
    await assert.rejects(() => s.bind({ appId: 'cli_1234567890abcd', appSecret: 'x'.repeat(32) }, ip), (e) => e.status === 429);
  } finally {
    restore();
  }
});

test('一键创建：会话记录带 10 分钟过期时间，用户走掉也不会留在库里', async () => {
  const origBegin = reg.begin;
  reg.begin = async () => ({ url: 'https://x', deviceCode: 'dc', intervalMs: 3000, expiresInMs: 600000 });
  const base = t.memoryStorage();
  const sets = [];
  t.setStorage({ ...base, set: (k, v, ex) => (sets.push({ k, ex }), base.set(k, v, ex)) });
  try {
    const { sessionId } = await s.createAppBegin();
    const hit = sets.find((x) => x.k === `reg:${sessionId}`);
    assert.ok(hit, '会话写进了库');
    assert.strictEqual(hit.ex, 600);
  } finally {
    reg.begin = origBegin;
  }
});

test('clientIp：取 x-real-ip，没有就取 x-forwarded-for 的第一个', () => {
  assert.strictEqual(s.clientIp({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }), '1.2.3.4');
  assert.strictEqual(s.clientIp({ 'x-forwarded-for': '5.6.7.8, 9.9.9.9' }), '5.6.7.8');
  assert.strictEqual(s.clientIp({}), '');
});

test('admin：未知操作 → 400', async () => {
  await assert.rejects(() => s.admin({ action: 'nope' }, { 'x-admin-token': 'admin-token-test' }), (e) => e.status === 400);
});

// ── bind 参数校验（不打飞书） ──────────────────────────
test('bind：App ID / Secret 格式不对 → 400，且不发网络请求', async () => {
  await assert.rejects(() => s.bind({ appId: 'bad', appSecret: 'x'.repeat(30) }), (e) => e.status === 400 && e.code === 'invalid_app_id');
  await assert.rejects(() => s.bind({ appId: 'cli_1234567890abcd', appSecret: 'short' }), (e) => e.status === 400 && e.code === 'invalid_app_secret');
});

// ── 建表字段（回归：漏了选项会导致记账写入失败） ─────────
test('建表字段：「账单类目」单选必须带全部 9 个选项，且与记账接口一致', () => {
  const { CATEGORY_OPTIONS } = require('./accounting.js');
  const spec = s.categoryFieldSpec();
  assert.strictEqual(spec.field_name, '账单类目');
  assert.strictEqual(spec.type, 3);
  assert.ok(Array.isArray(spec.property?.options), '单选字段必须带选项，否则飞书写入会拒');
  const names = spec.property.options.map((o) => o.name);
  assert.deepStrictEqual(names, CATEGORY_OPTIONS, '选项列表必须与 accounting.js 的 CATEGORY_OPTIONS 完全一致');
  assert.strictEqual(names.length, 9);
});

test('建表字段：账本表需要备注/金额/记账日期/账单类目/复盘 五个字段', () => {
  const names = s.FIELDS_SPEC.map((f) => f.name);
  assert.deepStrictEqual(names, ['备注', '金额', '记账日期', '账单类目', '复盘']);
  assert.strictEqual(s.LEDGER_NAME, '记账数据库');
});

// ── 到期提醒（cron） ──────────────────────────────────
test('shouldRenewRemind：只挑到期窗口内、且 3 天内没提醒过的', () => {
  const now = Date.now();
  const D = 86400_000;
  assert.strictEqual(s.shouldRenewRemind({ expireAt: now + 3 * D }, now), true);
  assert.strictEqual(s.shouldRenewRemind({ expireAt: now + 30 * D }, now), false, '还早的不打扰');
  assert.strictEqual(s.shouldRenewRemind({ expireAt: now - 5 * D }, now), true, '过期不超 14 天也提醒');
  assert.strictEqual(s.shouldRenewRemind({ expireAt: now - 30 * D }, now), false, '过期太久不再打扰');
  assert.strictEqual(s.shouldRenewRemind({ expireAt: now + 3 * D, renewRemindedAt: now - 1 * D }, now), false, '3 天内提醒过就不重复');
  assert.strictEqual(s.shouldRenewRemind({ expireAt: now + 3 * D, renewRemindedAt: now - 5 * D }, now), true);
  assert.strictEqual(s.shouldRenewRemind({ expireAt: 0 }, now), false, '没开通的不管');
  assert.strictEqual(s.shouldRenewRemind(null, now), false);
});

test('cronRemind：开源版直接跳过', async () => {
  const out = await s.cronRemind();
  assert.strictEqual(out.skipped, 'not_saas');
});

test('cronRemind：配了 CRON_SECRET 时校验 Bearer；对了才执行', async () => {
  process.env.SAAS_MODE = '1';
  process.env.CRON_SECRET = 'cron-secret-test';
  try {
    await assert.rejects(() => s.cronRemind({ authorization: 'Bearer wrong' }), (e) => e.status === 401);
    const out = await s.cronRemind({ authorization: 'Bearer cron-secret-test' });
    assert.strictEqual(out.ok, true);
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test('cronRemind：线上版扫租户，窗口外的完全不碰（不触发网络）', async () => {
  process.env.SAAS_MODE = '1';
  await makeTenant({ expireAt: Date.now() + 100 * 86400_000 }); // 还早 → 不该进候选
  const out = await s.cronRemind();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.tenants, 1);
  assert.strictEqual(out.candidates, 0);
  assert.strictEqual(out.sent, 0);
});

test('cronRemind：提醒时间记在单独的键里，不回写租户记录（不会盖掉同时进行的激活）', async () => {
  process.env.SAAS_MODE = '1';
  const { rec } = await makeTenant({ expireAt: Date.now() + 3 * 86400_000 });
  const before = await t.storage().get(`t:${rec.id}`);
  const orig = global.fetch;
  global.fetch = async (url) => {
    const ok = (data) => ({ status: 200, ok: true, json: async () => data });
    if (String(url).includes('tenant_access_token')) return ok({ code: 0, tenant_access_token: 'tok', expire: 7200 });
    return ok({ code: 0, data: { items: [], has_more: false } }); // 没有「提醒订阅」表 = 没有开提醒的设备
  };
  try {
    const out = await s.cronRemind();
    assert.strictEqual(out.candidates, 1);
    assert.ok(await t.storage().get(`rr:${rec.id}`), '记下了这次提醒的时间');
    assert.strictEqual(await t.storage().get(`t:${rec.id}`), before, '租户记录一个字没动');
    const again = await s.cronRemind();
    assert.strictEqual(again.candidates, 0, '3 天内不重复提醒');
  } finally {
    global.fetch = orig;
  }
});

test('cronRemind：到期提醒按每台设备选的语言推（英文设备收到英文，以前的订阅照旧中文）', async () => {
  process.env.SAAS_MODE = '1';
  const crypto = require('node:crypto');
  const { generateVapidKeys } = require('./webpush.js');
  const keys = generateVapidKeys();
  Object.assign(process.env, { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'https://my.example.com' });
  const b64u = (x) => Buffer.from(x).toString('base64url');
  const dev = (name, lang) => {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    return { name, ua, auth, sub: { endpoint: `https://push.example/${name}`, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) }, ...(lang ? { lang } : {}) } };
  };
  const decrypt = (buf, { ua, auth }) => {
    const salt = buf.subarray(0, 16);
    const asPublic = buf.subarray(21, 21 + buf[20]);
    const ct = buf.subarray(21 + buf[20]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).subarray(0, -1));
  };
  const en = dev('en', 'en');
  const zh = dev('zh');
  await makeTenant({ expireAt: Date.now() + 3 * 86400_000 });
  const pushed = {};
  const orig = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (data) => ({ status: 200, ok: true, json: async () => data, text: async () => '' });
    if (u.includes('tenant_access_token')) return ok({ code: 0, tenant_access_token: 'tok', expire: 7200 });
    if (u.startsWith('https://push.example/')) return (pushed[u.split('/').pop()] = Buffer.from(init.body)), { status: 201, ok: true, text: async () => '' };
    if (/\/tables\?/.test(u)) return ok({ code: 0, data: { items: [{ table_id: 'tblSubs', name: '提醒订阅' }], has_more: false } });
    if (u.includes('/tblSubs/records/search')) return ok({ code: 0, data: { items: [en, zh].map((x, i) => ({ record_id: `rec${i}`, fields: { 订阅: JSON.stringify(x.sub), 设备: x.name } })), has_more: false } });
    return ok({ code: 0, data: {} });
  };
  try {
    const out = await s.cronRemind();
    assert.strictEqual(out.sent, 2);
    const enMsg = decrypt(pushed.en, en);
    assert.strictEqual(enMsg.title, 'Kongbei Ledger · Membership ending');
    assert.match(enMsg.body, /^Your membership ends in 3 days\. Renew to keep logging/);
    assert.ok(!/[\u4e00-\u9fff]/.test(enMsg.title + enMsg.body));
    const zhMsg = decrypt(pushed.zh, zh);
    assert.strictEqual(zhMsg.title, '空杯记账 · 会员要到期了');
    assert.match(zhMsg.body, /^还有 3 天到期/);
  } finally {
    global.fetch = orig;
    for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k];
  }
});

// ── 一键创建应用（设备授权两步式） ────────────────────
// 说明：这里替换 feishu-register 的 begin/poll（它是纯网络层），并替换全局 fetch（模拟飞书业务接口），
// 从而在无网络依赖下验证「begin → session → poll → 建表 → 发口令」整条链路。
const reg = require('./feishu-register.js');

function mockFeishuFetch() {
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (data) => ({ status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.includes('/auth/v3/tenant_access_token/internal')) return ok({ code: 0, tenant_access_token: 'tok', expire: 7200 });
    if (u.includes('/drive/v1/files')) return ok({ code: 0, data: { files: [] } }); // 云空间里没有已有账本
    if (u.includes('/bitable/v1/apps') && u.endsWith('/apps')) return ok({ code: 0, data: { app: { app_token: 'basn_new', default_table_id: 'tbl_new', url: 'https://feishu.cn/base/basn_new' } } });
    if (u.includes('/fields') && opts.method === 'GET') return ok({ code: 0, data: { items: [{ field_id: 'fld_primary', field_name: '文本', is_primary: true }] } });
    if (u.includes('/fields')) return ok({ code: 0, data: {} });
    return ok({ code: 0, data: {} });
  };
  return () => {
    global.fetch = orig;
  };
}

test('一键创建：begin 拿链接和会话；轮询在用户确认前返回 pending', async () => {
  const origBegin = reg.begin;
  const origPoll = reg.poll;
  reg.begin = async () => ({ url: 'https://open.feishu.cn/page/launcher?user_code=AAAA-BBBB', deviceCode: 'dc-1', intervalMs: 5000, expiresInMs: 600000 });
  reg.poll = async () => ({ pending: true });
  try {
    const out = await s.createAppBegin();
    assert.strictEqual(out.ok, true);
    assert.match(out.url, /launcher\?user_code=/);
    assert.ok(out.sessionId.length > 12);
    assert.ok(out.intervalMs >= 3000, '轮询间隔不应低于 3 秒');

    const pollOut = await s.createAppPoll({ sessionId: out.sessionId });
    assert.strictEqual(pollOut.pending, true);
  } finally {
    reg.begin = origBegin;
    reg.poll = origPoll;
  }
});

test('一键创建：会话不存在 / 已过期 → 410', async () => {
  await assert.rejects(() => s.createAppPoll({ sessionId: 'not-exist' }), (e) => e.status === 410);
  await assert.rejects(() => s.createAppPoll({}), (e) => e.status === 400);
});

test('一键创建：用户在飞书取消 → 403，且会话被清掉', async () => {
  const origBegin = reg.begin;
  const origPoll = reg.poll;
  reg.begin = async () => ({ url: 'https://x', deviceCode: 'dc-cancel', intervalMs: 3000, expiresInMs: 600000 });
  reg.poll = async () => ({ denied: true });
  try {
    const { sessionId } = await s.createAppBegin();
    await assert.rejects(() => s.createAppPoll({ sessionId }), (e) => e.status === 403);
    // 会话已清：再轮询就是 410
    await assert.rejects(() => s.createAppPoll({ sessionId }), (e) => e.status === 410);
  } finally {
    reg.begin = origBegin;
    reg.poll = origPoll;
  }
});

test('一键创建：用户确认 → 拿到凭证 → 自动建表 → 发租户口令（完整链路）', async () => {
  const origBegin = reg.begin;
  const origPoll = reg.poll;
  reg.begin = async () => ({ url: 'https://x', deviceCode: 'dc-ok', intervalMs: 3000, expiresInMs: 600000 });
  reg.poll = async () => ({ appId: 'cli_autocreated01', appSecret: 'secret-of-autocreated-app' });
  const restore = mockFeishuFetch();
  try {
    const { sessionId } = await s.createAppBegin();
    const out = await s.createAppPoll({ sessionId });
    assert.strictEqual(out.ok, true);
    assert.ok(out.accessToken.includes('.'));
    assert.strictEqual(out.tableId, 'tbl_new');
    assert.strictEqual(out.created, true);

    // 租户真的落库了：用发下来的口令能解析出上下文
    const ctx = await t.resolveTenant(out.accessToken);
    assert.ok(ctx);
    assert.strictEqual(ctx.config.FEISHU_APP_ID, 'cli_autocreated01');
    assert.strictEqual(ctx.config.BASE_TOKEN, 'basn_new');
    assert.ok(out.expireAt > Date.now(), '首次绑定应带试用期');

    // 会话用完即删：再轮询就是 410
    await assert.rejects(() => s.createAppPoll({ sessionId }), (e) => e.status === 410);
  } finally {
    restore();
    reg.begin = origBegin;
    reg.poll = origPoll;
  }
});

test('withTenant tenantOnGet：GET 带记账口令 → 认出租户（取分类菜单）；不带口令 → 健康检查不鉴权；到期了 GET 照样放行', async () => {
  process.env.SAAS_MODE = '1';
  const { rec } = await makeTenant({ expireAt: Date.now() - 1000 });
  const account = t.decryptText(rec.accountEnc);
  const seen = [];
  const h = s.withTenant(async () => (seen.push(t.cacheKey()), { statusCode: 200, body: '{"ok":true}' }), { write: true, tenantOnGet: true });
  const withKey = await h({ requestContext: { http: { method: 'GET' } }, queryParameters: { key: account, menu: '1' }, headers: {} });
  assert.strictEqual(withKey.statusCode, 200);
  assert.strictEqual(seen.at(-1), rec.id, '在租户上下文里跑');
  const health = await h({ requestContext: { http: { method: 'GET' } }, queryParameters: {}, headers: {} });
  assert.strictEqual(health.statusCode, 200);
  const wrong = await h({ requestContext: { http: { method: 'GET' } }, queryParameters: { key: 'u0000000000.wrongwrongwrongwrong', menu: '1' }, headers: {} });
  assert.strictEqual(wrong.statusCode, 401);
});
