'use strict';
// 记账接口：不联网的部分（校验、分类、日期、防重复编号、口令）
const test = require('node:test');
const assert = require('node:assert');

process.env.ACCOUNTING_SECRET = 'test-secret';
const { handle, buildRecord, clientToken, normalizeCategory, normalizeDate } = require('./accounting.js');

const post = (body, headers = {}, queryParameters = {}) =>
  handle({ headers: { 'Content-Type': 'application/json', ...headers }, queryParameters, requestContext: { http: { method: 'POST' } }, body: typeof body === 'string' ? body : JSON.stringify(body) }).then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));

test('分类：带不带 emoji 都认，空的记成「人情」，不在列表里报错；改过名的旧名字照样认、存成新名字', () => {
  assert.equal(normalizeCategory('一日三餐'), '🍲一日三餐');
  assert.equal(normalizeCategory('🚪外出'), '🚪外出');
  assert.equal(normalizeCategory('投资蜕变·大额'), '💰投资蜕变·大额');
  assert.equal(normalizeCategory(''), '🏷️人情');
  assert.throws(() => normalizeCategory('火锅'), /不在允许列表/);
  assert.equal(normalizeCategory('开心购物'), '✨值得体验');
  assert.equal(normalizeCategory('✨开心购物'), '✨值得体验');
  assert.equal(normalizeCategory('其他'), '🏷️人情');
});

test('日期：缺省是现在；毫秒和带时区的 ISO 都认', () => {
  assert.equal(normalizeDate(undefined, 123), 123);
  assert.equal(normalizeDate(1790762617539), 1790762617539);
  assert.equal(normalizeDate('2026-10-01T12:00:00+08:00'), Date.parse('2026-10-01T04:00:00Z'));
  assert.throws(() => normalizeDate('昨天'), /可解析/);
});

test('字段：英文名和中文名都认，和原来的阿里云函数一致', () => {
  const r = buildRecord({ amount: '28.5', class: '一日三餐', event: ' 午饭 ', date: 1790762617539 });
  assert.deepEqual(r.fields, { 金额: 28.5, 记账日期: 1790762617539, 账单类目: '🍲一日三餐', 备注: '午饭' });
  assert.equal(buildRecord({ 金额: 3, 账单类目: '外出', 备注: '地铁' }).fields['账单类目'], '🚪外出');
});

test('收入一律存正数（快捷指令发的是负数）；支出和退款原样', () => {
  assert.equal(buildRecord({ amount: -13500, class: '收入' }).fields['金额'], 13500);
  assert.equal(buildRecord({ amount: '-10', class: '💳收入' }).fields['金额'], 10);
  assert.equal(buildRecord({ amount: 200, class: '收入' }).fields['金额'], 200);
  assert.equal(buildRecord({ amount: -28.5, class: '一日三餐' }).fields['金额'], -28.5);
  assert.equal(buildRecord({ amount: 30, class: '开心购物' }).fields['金额'], 30, '其它类目的正数是退款，不能翻');
});

test('防重复编号：同一个 id 永远同一个 UUIDv4；不同 id 不同；本身是 UUID 原样用；没给就不带', () => {
  const a = clientToken('20261002093011123-4821');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(clientToken('20261002093011123-4821'), a);
  assert.notEqual(clientToken('20261002093011123-4822'), a);
  assert.equal(clientToken('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  assert.equal(clientToken(''), null);
  assert.equal(clientToken(undefined), null);
});

test('口令：四种放法都认；错了 401（且故意慢一点）', async () => {
  // 只测口令：口令对的那几条故意给错金额，让它在联网写飞书之前就以 400 停下
  const bad = await post({ amount: 1, class: '其他', secret: 'wrong' });
  assert.equal(bad.status, 401);
  assert.equal((await post({ amount: 1 }, {}, { key: 'wrong' })).status, 401);
  for (const [body, headers, query] of [
    [{ amount: 'x', secret: 'test-secret' }, {}],
    [{ amount: 'x' }, { Authorization: 'Bearer test-secret' }],
    [{ amount: 'x' }, { 'X-Accounting-Secret': 'test-secret' }],
    [{ amount: 'x' }, {}, { key: 'test-secret' }], // 专属记账地址 …/api/accounting?key=
  ]) {
    const r = await post(body, headers, query);
    assert.equal(r.status, 400, '口令对了才会走到金额校验');
    assert.equal(r.error, 'invalid_amount');
  }
});

test('格式：不是 JSON、不是 POST 都拒绝；GET 是健康检查', async () => {
  assert.equal((await post('{oops', { Authorization: 'Bearer test-secret' })).error, 'invalid_json');
  const notJson = await handle({ headers: { 'Content-Type': 'text/plain' }, requestContext: { http: { method: 'POST' } }, body: '{}' });
  assert.equal(notJson.statusCode, 415);
  const get = await handle({ headers: {}, requestContext: { http: { method: 'GET' } }, body: '' });
  assert.equal(JSON.parse(get.body).service, 'kongbei-accounting');
});

test('金额：空字符串和 0 拒绝，不静默写一笔 0（2026-11-09 快捷指令没取到金额）', async () => {
  env4();
  for (const amount of ['', '   ', 0, '0']) {
    const r = await post({ amount, class: '一日三餐' }, auth);
    assert.equal(r.status, 400, `amount=${JSON.stringify(amount)} 应该被拒`);
    assert.equal(r.error, 'invalid_amount');
  }
  const bodies = [];
  fakeFeishu([{ code: 0, data: { record: { record_id: 'rec-amt' } } }], bodies);
  const ok = await post({ amount: '-28.5', class: '一日三餐', date: 1790762617539 }, auth);
  assert.equal(ok.ok, true);
  assert.equal(bodies[0].fields['金额'], -28.5);
});

// ── 模拟飞书：重试、重复提交 ──────────────────────────
function fakeFeishu(createReplies, bodies = []) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }));
    if (/\/tables\?page_size=100/.test(String(url))) return new Response(JSON.stringify({ code: 0, data: { items: [], has_more: false } }));
    if (String(url).includes('/records') && init?.body) bodies.push(JSON.parse(init.body));
    const next = createReplies.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next));
  };
  return calls;
}
const env4 = () => Object.assign(process.env, { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 's', BASE_TOKEN: 'b', TABLE_ID: 't' });
const auth = { Authorization: 'Bearer test-secret' };

test('写飞书第一次连不上 → 自动重试，第二次成功', async () => {
  env4();
  const calls = fakeFeishu([new TypeError('fetch failed'), { code: 0, data: { record: { record_id: 'rec1' } } }]);
  const r = await post({ amount: 12, class: '一日三餐', event: '午饭', date: 1790762617539, id: 'x1' }, auth);
  assert.equal(r.ok, true);
  assert.equal(r.shortcut_status, 'saved');
  assert.equal(r.record_id, 'rec1');
  assert.equal(r.attempts, 2);
  assert.ok(calls.filter((u) => u.includes('/records?client_token=')).length === 2, '两次都带着同一个防重复编号');
});

test('同一笔重发（飞书说重复提交）→ 当成功，不让快捷指令去走备用线路', async () => {
  env4();
  fakeFeishu([{ code: 1254608, msg: 'Same API requests are submitted repeatedly.' }]);
  const r = await post({ amount: 12, class: '一日三餐', date: 1790762617539, id: 'x1' }, auth);
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true);
});

test('参数错（飞书 4xx）不重试，直接报错', async () => {
  env4();
  const calls = fakeFeishu([{ code: 1254045, msg: 'FieldNameNotFound' }]);
  const r = await post({ amount: 12, class: '一日三餐', id: 'x2' }, auth);
  assert.equal(r.ok, false);
  assert.equal(r.shortcut_status, 'failed');
  assert.equal(calls.filter((u) => u.includes('/records')).length, 1);
});

// ── 分类菜单 + 改过名的类目（2026-10-18）：快捷指令记账前来取菜单；记账时发回来的是菜单上的名字 ──
const settings = require('./settings.js');
const get = (queryParameters) => handle({ headers: {}, queryParameters, requestContext: { http: { method: 'GET' } }, body: '' }).then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));
function stubNames(names, calls = []) {
  const orig = settings.getSettings;
  settings.getSettings = async (maxAgeMs) => (calls.push(maxAgeMs), { names: typeof names === 'function' ? names(maxAgeMs) : names });
  return () => (settings.getSettings = orig);
}

test('分类：按看板里改过的名字认（带不带 emoji、有没有空格都行），原名和旧名照样认', () => {
  const names = { '✨值得体验': '🎮娱乐', '👌投资蜕变': '学习 成长' };
  assert.equal(normalizeCategory('🎮 娱乐', names), '✨值得体验');
  assert.equal(normalizeCategory('娱乐', names), '✨值得体验');
  assert.equal(normalizeCategory('👌 学习成长', names), '👌投资蜕变');
  assert.equal(normalizeCategory('值得体验', names), '✨值得体验', '原名照样认（没重装的老快捷指令）');
  assert.equal(normalizeCategory('🍲 一日三餐', names), '🍲一日三餐', '菜单上的原名带空格也认');
  assert.throws(() => normalizeCategory('火锅', names), /🎮 娱乐/, '报错里列的是菜单上现在的名字');
});

test('分类菜单：要记账口令；按第一版快捷指令的顺序；改过名的用新名字', async () => {
  const restore = stubNames({ '✨值得体验': '🎮娱乐', '🏠住房': '房租水电' });
  try {
    const bad = await get({ key: 'wrong', menu: '1' });
    assert.equal(bad.status, 401);
    const ok = await get({ key: 'test-secret', menu: '1' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.menu, ['🍲 一日三餐', '🛍️ 生活日常', '🎮 娱乐', '👌 投资蜕变', '🚪 外出', '🏠 房租水电', '🏷️ 人情', '💰 投资蜕变·大额', '💳 收入']);
    const health = await get({});
    assert.equal(health.service, 'kongbei-accounting', '不带 menu 还是健康检查');
  } finally {
    restore();
  }
});

test('分类菜单：设置读不到时明确失败，不把旧分类当作最新菜单', async () => {
  const orig = settings.getSettings;
  settings.getSettings = async () => {
    throw new Error('飞书挂了');
  };
  try {
    const ok = await get({ key: 'test-secret', menu: '1' });
    assert.equal(ok.status, 502);
    assert.equal(ok.error, 'settings_unavailable');
  } finally {
    settings.getSettings = orig;
  }
});

test('记账：新名字和原名都认，设置走 1 分钟缓存（读一次要 2.4 秒，不能每笔现读）', async () => {
  const calls = [];
  const restore = stubNames((maxAgeMs) => (maxAgeMs > 0 ? { '✨值得体验': '🎮娱乐' } : {}), calls);
  try {
    const r = await post({ amount: -45, class: '🎮 娱乐', dryRun: true }, { authorization: 'Bearer test-secret' });
    // dryRun 要取飞书 token，这里没配飞书，会在那一步失败；只要类目认对了（不是 invalid_category）就行
    assert.notEqual(r.error, 'invalid_category', JSON.stringify(r));
    assert.deepEqual(calls, [60_000], '写账前读设置，走 1 分钟缓存');
    calls.length = 0;
    await post({ amount: -12, class: '一日三餐', dryRun: true }, { authorization: 'Bearer test-secret' });
    assert.deepEqual(calls, [60_000], '旧快捷指令的原名也要映射为当前名字');
  } finally {
    restore();
  }
});

test('取菜单仍然读最新设置（改名后下次记账立刻用新名字）', async () => {
  const calls = [];
  const restore = stubNames((maxAgeMs) => (maxAgeMs === 0 ? { '✨值得体验': '🎮娱乐' } : {}), calls);
  try {
    const ok = await get({ key: 'test-secret', menu: '1' });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [0], '取菜单不缓存，永远读最新');
    assert.ok(ok.menu.includes('🎮 娱乐'));
  } finally {
    restore();
  }
});

test('旧快捷指令提交原名时，实际写入飞书的是当前分类名', async () => {
  env4();
  const restore = stubNames({ '🍲一日三餐': '🍜餐饮' });
  const bodies = [];
  fakeFeishu([{ code: 0, data: { record: { record_id: 'rec1' } } }], bodies);
  try {
    const r = await post({ amount: -25, class: '一日三餐', event: '午饭' }, auth);
    assert.equal(r.ok, true);
    assert.equal(bodies[0].fields['账单类目'], '🍜餐饮');
    assert.equal(r.menu[0], '🍜 餐饮', '成功后返回当前菜单，供下次本地选择');
    assert.equal(r.menu.length, 9);
  } finally { restore(); }
});

test('缓存的旧名字在改名后仍能记账，返回菜单供下一次更新', async () => {
  env4();
  const original = settings.getSettings;
  settings.getSettings = async () => ({ names: { '🍲一日三餐': '🍜美食' }, aliases: { '🍲一日三餐': ['🍜餐饮'] } });
  const bodies = [];
  fakeFeishu([{ code: 0, data: { record: { record_id: 'rec-cache' } } }], bodies);
  try {
    const r = await post({ amount: -25, class: '🍜 餐饮' }, auth);
    assert.equal(r.ok, true);
    assert.equal(bodies[0].fields['账单类目'], '🍜美食');
    assert.equal(r.menu[0], '🍜 美食');
  } finally { settings.getSettings = original; }
});

test('读不到分类设置时不写入旧分类', async () => {
  const original = settings.getSettings;
  settings.getSettings = async () => { throw new Error('暂时不可用'); };
  const bodies = [];
  fakeFeishu([], bodies);
  try {
    const r = await post({ amount: -25, class: '一日三餐' }, auth);
    assert.equal(r.status, 502);
    assert.equal(r.error, 'settings_unavailable');
    assert.equal(bodies.length, 0);
  } finally { settings.getSettings = original; }
});
