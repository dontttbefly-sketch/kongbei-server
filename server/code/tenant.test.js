'use strict';
// 租户层测试：加密往返、口令格式、上下文注入与回退、租户解析、会员判定
const { test } = require('node:test');
const assert = require('node:assert');
const t = require('./tenant.js');

// 测试用固定主密钥（生产走 Vercel 环境变量）
process.env.SAAS_SECRET = 'test-master-secret-0123456789';

test('加解密：往返一致，且同一明文两次密文不同（IV 随机）', () => {
  const plain = 'cli_a1b2c3:secret_value.中文也能过';
  const a = t.encryptText(plain);
  const b = t.encryptText(plain);
  assert.notStrictEqual(a, b);
  assert.strictEqual(t.decryptText(a), plain);
  assert.strictEqual(t.decryptText(b), plain);
  assert.ok(a.startsWith('v1.'));
});

test('加解密：密文被篡改时解密失败（GCM 完整性）', () => {
  const packed = t.encryptText('hello');
  const parts = packed.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${Buffer.from('x'.repeat(8)).toString('base64url')}`;
  assert.throws(() => t.decryptText(tampered));
});

test('加解密：缺少 SAAS_SECRET 时报错', () => {
  const old = process.env.SAAS_SECRET;
  delete process.env.SAAS_SECRET;
  try {
    assert.throws(() => t.encryptText('x'), /SAAS_SECRET/);
  } finally {
    process.env.SAAS_SECRET = old;
  }
});

test('口令：生成 → 解析 往返一致', () => {
  const id = t.newUserId();
  assert.match(id, /^u[0-9a-f]{10}$/);
  const token = t.newToken(id);
  const parsed = t.parseToken(token);
  assert.strictEqual(parsed.userId, id);
  assert.ok(parsed.secret.length >= 16);
});

test('口令：格式不对的一律解析失败', () => {
  assert.strictEqual(t.parseToken(''), null);
  assert.strictEqual(t.parseToken('no-dot'), null);
  assert.strictEqual(t.parseToken('u123.short'), null); // ID 不够长
  assert.strictEqual(t.parseToken('x1234567890.a'.repeat(1)), null); // ID 前缀不对
  assert.strictEqual(t.parseToken('u1234567890.short'), null); // 随机串太短
  assert.strictEqual(t.parseToken(null), null);
});

test('safeEqualText：等长才比较，长度不同直接 false', () => {
  assert.strictEqual(t.safeEqualText('abc', 'abc'), true);
  assert.strictEqual(t.safeEqualText('abc', 'abd'), false);
  assert.strictEqual(t.safeEqualText('abc', 'abcd'), false);
});

test('configOf：无上下文回退环境变量，有上下文优先用租户值', () => {
  process.env.TEST_KEY_A = 'from-env';
  const seen = [];
  seen.push(t.configOf('TEST_KEY_A'));
  // 上下文里没有的键 → 仍回退环境变量
  t.runWithTenant({ key: 'u1', tenant: {}, config: { TEST_KEY_B: 'from-tenant' } }, () => {
    seen.push(t.configOf('TEST_KEY_B'));
    seen.push(t.configOf('TEST_KEY_A'));
  });
  // 上下文结束后恢复
  seen.push(t.configOf('TEST_KEY_B'));
  assert.deepStrictEqual(seen, ['from-env', 'from-tenant', 'from-env', undefined]);
  delete process.env.TEST_KEY_A;
});

test('cacheKey：无上下文为 env，有上下文为租户 ID', () => {
  assert.strictEqual(t.cacheKey(), 'env');
  t.runWithTenant({ key: 'uabcdef0123', tenant: {}, config: {} }, () => {
    assert.strictEqual(t.cacheKey(), 'uabcdef0123');
  });
});

test('resolveTenant：完整链路（存租户 → 凭口令解析 → 注入配置）', async () => {
  t.setStorage(t.memoryStorage());
  const id = t.newUserId();
  const access = t.newToken(id);
  const account = t.newToken(id);
  const rec = {
    id,
    createdAt: Date.now(),
    expireAt: Date.now() + 86400_000,
    appId: 'cli_test_app',
    secretEnc: t.encryptText('the-app-secret'),
    accessEnc: t.encryptText(access),
    accountEnc: t.encryptText(account),
    baseToken: 'bascn123',
    tableId: 'tbl456',
  };
  await t.saveTenant(rec);

  const ctx1 = await t.resolveTenant(access);
  assert.ok(ctx1);
  assert.strictEqual(ctx1.config.FEISHU_APP_ID, 'cli_test_app');
  assert.strictEqual(ctx1.config.FEISHU_APP_SECRET, 'the-app-secret');
  assert.strictEqual(ctx1.config.BASE_TOKEN, 'bascn123');
  assert.strictEqual(ctx1.config.TABLE_ID, 'tbl456');
  assert.strictEqual(ctx1.config.API_TOKEN, access);
  assert.strictEqual(ctx1.config.ACCOUNTING_SECRET, account);

  // 记账口令也能解析（快捷指令场景）
  const ctx2 = await t.resolveTenant(account);
  assert.ok(ctx2);

  // 错误口令解析不到
  assert.strictEqual(await t.resolveTenant(`${id}.${'x'.repeat(24)}`), null);
  // 不存在的用户
  assert.strictEqual(await t.resolveTenant(`${t.newUserId()}.${'y'.repeat(24)}`), null);
  // 缓存命中后仍然正确
  const ctx3 = await t.resolveTenant(access);
  assert.strictEqual(ctx3.config.API_TOKEN, access);
  t.clearResolveCache();
});

test('memberActive：未开通、已过期、有效 三种情况', () => {
  const now = Date.now();
  assert.strictEqual(t.memberActive({ expireAt: 0 }, now), false);
  assert.strictEqual(t.memberActive({ expireAt: now - 1 }, now), false);
  assert.strictEqual(t.memberActive({ expireAt: now + 1 }, now), true);
  assert.strictEqual(t.memberActive(null, now), false);
});

test('激活码：格式可读、去混淆字符、规范化幂等', () => {
  const code = t.newCode();
  assert.match(code, /^KB-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(!/[ILO01]/.test(code), '不应包含易混字符');
  assert.strictEqual(t.normalizeCode(code.toLowerCase()), code);
  assert.strictEqual(t.normalizeCode(` ${code} `), code);
});
