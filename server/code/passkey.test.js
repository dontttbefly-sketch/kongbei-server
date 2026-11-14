'use strict';
// 面容 ID 登录接口测试：线上版（租户库，内存实现）和开源版（飞书「登录设备」表，假的飞书）两条路都走一遍
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const t = require('./tenant.js');
const feishu = require('./feishu.js');
const passkey = require('./passkey.js');
const { authenticator } = require('../test/fake-authenticator.js');

process.env.SAAS_SECRET = 'passkey-test-master-secret-0123';

const HOST = 'my.example.com';
const ORIGIN = `https://${HOST}`;
const call = async (body, headers = {}) => {
  const out = await passkey.handle({ method: 'POST', headers: { host: HOST, ...headers }, body: JSON.stringify(body) });
  return { status: out.statusCode, ...JSON.parse(out.body) };
};

async function makeTenant() {
  const id = t.newUserId();
  const access = t.newToken(id);
  const account = t.newToken(id);
  await t.saveTenant({ id, createdAt: Date.now(), boundAt: Date.now(), expireAt: Date.now() + 86400_000, appId: `cli_${id}`, secretEnc: t.encryptText('s'), accessEnc: t.encryptText(access), accountEnc: t.encryptText(account), baseToken: 'bascn', tableId: 'tbl' });
  return { id, access, account };
}

// 走一遍开启：拿参数 → 认证器签 → 交回去
async function enable(a, token) {
  const begin = await call({ op: 'register-begin', token });
  assert.strictEqual(begin.ok, true, JSON.stringify(begin));
  const credential = a.register({ challenge: begin.options.challenge, origin: ORIGIN });
  return call({ op: 'register-finish', token, credential, device: 'iPhone' });
}
async function login(a, userHandle) {
  const begin = await call({ op: 'login-begin' });
  return call({ op: 'login-finish', credential: a.login({ challenge: begin.options.challenge, origin: ORIGIN, userHandle }) });
}

beforeEach(() => {
  t.setStorage(t.memoryStorage());
  t.clearResolveCache();
  passkey._resetCache();
});

// ── 线上版 ─────────────────────────────────────────────
test('线上版：开启 → 面容登录拿回看板口令 → 列出 → 删除后登不了', async () => {
  process.env.SAAS_MODE = '1';
  try {
    const { id, access } = await makeTenant();
    const a = authenticator(HOST);
    const on = await enable(a, access);
    assert.strictEqual(on.ok, true, JSON.stringify(on));
    assert.strictEqual(on.passkey.device, 'iPhone');

    const begin = await call({ op: 'register-begin', token: access });
    assert.deepStrictEqual(begin.options.excludeCredentials, [{ type: 'public-key', id: a.credId }], '已经开过的设备不再重复开');
    assert.strictEqual(begin.options.rp.id, HOST);
    assert.strictEqual(Buffer.from(begin.options.user.id, 'base64url').toString(), id);

    const ok = await login(a, id);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(ok.token, access);

    const list = await call({ op: 'list', token: access });
    assert.strictEqual(list.passkeys.length, 1);
    assert.ok(!('jwk' in list.passkeys[0]), '列表不往外给公钥');

    const rm = await call({ op: 'remove', token: access, id: a.credId });
    assert.strictEqual(rm.removed, 1);
    const after = await login(a, id);
    assert.strictEqual(after.status, 401);
    assert.strictEqual(after.error, 'passkey_unknown');
  } finally {
    delete process.env.SAAS_MODE;
  }
});

test('线上版：同一个登录签名用两次 → 第二次不认（防重放）', async () => {
  process.env.SAAS_MODE = '1';
  try {
    const { id, access } = await makeTenant();
    const a = authenticator(HOST);
    await enable(a, access);
    const begin = await call({ op: 'login-begin' });
    const assertion = a.login({ challenge: begin.options.challenge, origin: ORIGIN, userHandle: id });
    assert.strictEqual((await call({ op: 'login-finish', credential: assertion })).ok, true);
    const again = await call({ op: 'login-finish', credential: assertion });
    assert.strictEqual(again.status, 401);
  } finally {
    delete process.env.SAAS_MODE;
  }
});

test('线上版：记账口令开不了面容登录；A 的通行密钥不能挂到 B 上；换过口令后面容登录拿到新口令', async () => {
  process.env.SAAS_MODE = '1';
  try {
    const A = await makeTenant();
    const B = await makeTenant();
    const a = authenticator(HOST);
    assert.strictEqual((await call({ op: 'register-begin', token: A.account })).status, 401, '记账口令不行');
    assert.strictEqual((await enable(a, A.access)).ok, true);
    const stolen = await enable(a, B.access);
    assert.strictEqual(stolen.status, 409);
    assert.strictEqual(stolen.error, 'passkey_taken');

    const { rotate } = require('./saas.js');
    const r = await rotate({ token: A.access });
    const ok = await login(a, A.id);
    assert.strictEqual(ok.token, r.accessToken, '登录给的是最新的口令');

    const wrongHandle = await login(a, B.id);
    assert.strictEqual(wrongHandle.status, 401, '通行密钥里记的人和找到的租户对不上');
  } finally {
    delete process.env.SAAS_MODE;
  }
});

test('线上版：别的网站的通行密钥、乱发的凭据 → 401，不泄露任何东西', async () => {
  process.env.SAAS_MODE = '1';
  try {
    const { id, access } = await makeTenant();
    await enable(authenticator(HOST), access);
    const stranger = await login(authenticator(HOST), id);
    assert.strictEqual(stranger.status, 401);
    assert.ok(!stranger.token);
    const junk = await call({ op: 'login-finish', credential: { id: 'x', rawId: 'x', response: {} } });
    assert.strictEqual(junk.status, 401);
  } finally {
    delete process.env.SAAS_MODE;
  }
});

// ── 开源版（飞书表，用假的飞书） ───────────────────────────
function fakeFeishu() {
  const rows = new Map();
  let made = false;
  let n = 0;
  const orig = { findTable: feishu.findTable, search: feishu.search, call: feishu.call, tables: feishu.tables };
  feishu.findTable = async (name, fields) => {
    assert.strictEqual(name, passkey.TABLE);
    if (!made && fields) made = true;
    return made ? 'tblLogin' : '';
  };
  feishu.search = async () => [...rows].map(([record_id, fields]) => ({ record_id, fields }));
  feishu.tables = () => '/bitable/v1/apps/bascn/tables';
  feishu.call = async (path, { method, body }) => {
    const id = path.split('/').pop();
    if (method === 'POST') rows.set(`rec${++n}`, body.fields);
    else if (method === 'PUT') rows.set(id, body.fields);
    else if (method === 'DELETE') rows.delete(id);
    return {};
  };
  return { rows, restore: () => Object.assign(feishu, orig) };
}

test('开源版：存在飞书「登录设备」表；面容登录拿回 API_TOKEN；删掉后登不了', async () => {
  process.env.API_TOKEN = 'self-view-token';
  process.env.ACCOUNTING_SECRET = 'self-accounting-secret';
  const fake = fakeFeishu();
  try {
    const a = authenticator(HOST);
    assert.strictEqual((await call({ op: 'register-begin', token: 'wrong' })).status, 401);
    const on = await enable(a, 'self-view-token');
    assert.strictEqual(on.ok, true, JSON.stringify(on));
    assert.strictEqual(fake.rows.size, 1);
    const row = [...fake.rows.values()][0];
    assert.strictEqual(row['凭据'], a.credId);
    assert.ok(!JSON.parse(row['公钥']).jwk.d, '表里只有公钥');

    const ok = await login(a, 'kongbei-self');
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(ok.token, 'self-view-token');

    await call({ op: 'remove', token: 'self-view-token', id: a.credId });
    assert.strictEqual(fake.rows.size, 0);
    passkey._resetCache();
    assert.strictEqual((await login(a, 'kongbei-self')).error, 'passkey_unknown');
  } finally {
    fake.restore();
    delete process.env.API_TOKEN;
    delete process.env.ACCOUNTING_SECRET;
  }
});

test('网址：按请求的域名认通行密钥；本地开发 localhost 用 http', () => {
  assert.deepStrictEqual(passkey.siteOf({ host: 'app.kongbei.xyz' }), { rpId: 'app.kongbei.xyz', origin: 'https://app.kongbei.xyz' });
  assert.deepStrictEqual(passkey.siteOf({ 'x-forwarded-host': 'my.kongbei.xyz', host: 'internal' }), { rpId: 'my.kongbei.xyz', origin: 'https://my.kongbei.xyz' });
  assert.deepStrictEqual(passkey.siteOf({ host: 'localhost:5173' }), { rpId: 'localhost', origin: 'http://localhost:5173' });
});
