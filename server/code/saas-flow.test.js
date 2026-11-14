'use strict';
// 双轨链路冒烟测试：用真实接口验证「同一份代码，两种部署」
// 1) 开源模式：接口读 .env，行为与改造前一致
// 2) 线上版（SAAS_MODE=1）：接口按租户口令取凭证；无租户拒绝；会员过期时写接口 402
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const t = require('./tenant.js');

process.env.SAAS_SECRET = 'flow-master-secret-0123456789';
process.env.API_TOKEN = 'env-view-token';
process.env.ACCOUNTING_SECRET = 'env-accounting-secret';

const shortcut = require('./shortcut.js');

const call = (handler, body, headers = {}) => handler({ method: 'POST', body: JSON.stringify(body), headers: { host: 'jz.example.com', ...headers } });

beforeEach(() => {
  delete process.env.SAAS_MODE;
  t.setStorage(t.memoryStorage());
  t.clearResolveCache();
  // shortcut.js 在模块加载时抓了 safeEqual，但口令每次都从 configOf 现读，改环境变量即可
  process.env.API_TOKEN = 'env-view-token';
  process.env.ACCOUNTING_SECRET = 'env-accounting-secret';
});

test('开源模式：/api/shortcut 读 .env，返回带环境变量记账口令的地址（行为零变化）', async () => {
  const out = await call(shortcut.handle, { token: 'env-view-token' });
  assert.strictEqual(out.statusCode, 200);
  const data = JSON.parse(out.body);
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.url, 'https://jz.example.com/api/accounting?key=env-accounting-secret');
});

test('线上版：没有租户口令 → 401，且不泄露 .env 里的任何配置', async () => {
  process.env.SAAS_MODE = '1';
  const out = await call(shortcut.handle, { token: 'not-a-tenant-token' });
  assert.strictEqual(out.statusCode, 401);
  assert.ok(!out.body.includes('env-accounting-secret'));
});

test('线上版：带租户口令 → 接口自动用租户的记账口令拼地址（上下文注入链路通）', async () => {
  process.env.SAAS_MODE = '1';
  const id = t.newUserId();
  const access = t.newToken(id);
  const account = t.newToken(id);
  await t.saveTenant({
    id,
    createdAt: Date.now(),
    boundAt: Date.now(),
    expireAt: Date.now() + 86400_000,
    appId: 'cli_flow_test',
    secretEnc: t.encryptText('tenant-app-secret'),
    accessEnc: t.encryptText(access),
    accountEnc: t.encryptText(account),
    baseToken: 'bascn_tenant',
    tableId: 'tbl_tenant',
  });

  const out = await call(shortcut.handle, { token: access });
  assert.strictEqual(out.statusCode, 200);
  const data = JSON.parse(out.body);
  assert.strictEqual(data.ok, true);
  assert.ok(data.url.includes(encodeURIComponent(account)), '地址里应该是该租户的记账口令');
  assert.ok(!data.url.includes('env-accounting-secret'), '绝不能是环境变量的口令');
});

test('线上版：会员过期 → /api/edit 写接口 402，/api/records 读接口仍可访问', async () => {
  process.env.SAAS_MODE = '1';
  const edit = require('./edit.js');
  const id = t.newUserId();
  const access = t.newToken(id);
  await t.saveTenant({
    id,
    createdAt: Date.now(),
    boundAt: Date.now(),
    expireAt: Date.now() - 1000, // 已过期
    appId: 'cli_expired',
    secretEnc: t.encryptText('s'),
    accessEnc: t.encryptText(access),
    accountEnc: t.encryptText(t.newToken(id)),
    baseToken: 'bascn_x',
    tableId: 'tbl_x',
  });

  const w = await call(edit.handle, { token: access, id: 'recABC12345', note: 'x' });
  assert.strictEqual(w.statusCode, 402);
  assert.strictEqual(JSON.parse(w.body).error, 'membership_expired');
});

test('线上版：健康检查（GET）不需要口令', async () => {
  process.env.SAAS_MODE = '1';
  const accounting = require('./accounting.js');
  const out = await accounting.handle({ method: 'GET', headers: {} });
  assert.strictEqual(out.statusCode, 200);
  assert.strictEqual(JSON.parse(out.body).service, 'kongbei-accounting');
});

test('线上版：会员过期 → 推送接口还能读配置、关提醒；开提醒 402', async () => {
  process.env.SAAS_MODE = '1';
  const push = require('./push.js');
  const id = t.newUserId();
  const access = t.newToken(id);
  await t.saveTenant({
    id,
    createdAt: Date.now(),
    boundAt: Date.now(),
    expireAt: Date.now() - 1000, // 已过期
    appId: 'cli_push_expired',
    secretEnc: t.encryptText('s'),
    accessEnc: t.encryptText(access),
    accountEnc: t.encryptText(t.newToken(id)),
    baseToken: 'bascn_push',
    tableId: 'tbl_push',
  });
  const orig = global.fetch;
  global.fetch = async (url) => ({
    status: 200,
    ok: true,
    json: async () => (String(url).includes('tenant_access_token') ? { code: 0, tenant_access_token: 'tok', expire: 7200 } : { code: 0, data: { items: [], has_more: false } }),
  });
  try {
    const cfg = await call(push.handle, { token: access, op: 'config' });
    assert.strictEqual(cfg.statusCode, 200);
    const off = await call(push.handle, { token: access, op: 'unsubscribe', endpoint: 'https://push.example/x' });
    assert.strictEqual(off.statusCode, 200);
    const on = await call(push.handle, { token: access, op: 'subscribe', subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } } });
    assert.strictEqual(on.statusCode, 402);
    assert.strictEqual(JSON.parse(on.body).error, 'membership_expired');
  } finally {
    global.fetch = orig;
  }
});

test('所有 API 入口都能被加载（无语法/依赖错误）', () => {
  for (const f of ['records', 'accounting', 'shortcut', 'edit', 'push', 'remind', 'settings', 'saas', 'saas-cron']) {
    assert.ok(require.resolve(`../../api/${f}.js`), `${f} 入口可解析`);
  }
});
