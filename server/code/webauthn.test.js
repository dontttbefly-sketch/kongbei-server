'use strict';
// 面容 ID 登录的验签测试：用 node:crypto 现做一个「软件认证器」，按 WebAuthn 的格式签名，验正反两面
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const wa = require('./webauthn.js');
const { authenticator, cbor } = require('../test/fake-authenticator.js');

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();

const SECRET = Buffer.from('test-secret-for-challenges');
const RP = 'app.example.com';
const ORIGIN = 'https://app.example.com';
const regCheck = (bind = 'self') => (c) => wa.checkChallenge(SECRET, c, 'r', bind);
const loginCheck = (c) => wa.checkChallenge(SECRET, c, 'l');

function registered(kind = 'ec') {
  const a = authenticator(RP, kind);
  const cred = a.register({ challenge: wa.makeChallenge(SECRET, 'r', 'self'), origin: ORIGIN });
  const stored = wa.verifyRegistration({ credential: cred, checkChallenge: regCheck(), origin: ORIGIN, rpId: RP });
  return { a, stored };
}

test('CBOR：整数、负数、字节串、文本、数组、映射、true/false/null 都能解', () => {
  const m = new Map([[1, 2], [-1, 'x'], ['k', Buffer.from([1, 2, 3])], [3, [true, false, null, 300, 70000, -25]]]);
  const { value, length } = wa.decodeCbor(cbor(m));
  assert.strictEqual(length, cbor(m).length);
  assert.strictEqual(value.get(1), 2);
  assert.strictEqual(value.get(-1), 'x');
  assert.deepStrictEqual([...value.get('k')], [1, 2, 3]);
  assert.deepStrictEqual(value.get(3), [true, false, null, 300, 70000, -25]);
  assert.throws(() => wa.decodeCbor(Buffer.from([0x5f])), wa.WebAuthnError, '不定长不支持');
  assert.throws(() => wa.decodeCbor(Buffer.from([0x45, 1, 2])), wa.WebAuthnError, '数据不完整');
});

test('开启 + 登录：ES256（iPhone、Mac）、RS256、Ed25519 都验得过', () => {
  for (const kind of ['ec', 'rsa', 'ed']) {
    const { a, stored } = registered(kind);
    assert.strictEqual(stored.id, a.credId);
    assert.strictEqual(stored.alg, kind === 'ec' ? -7 : kind === 'rsa' ? -257 : -8);
    assert.deepStrictEqual(stored.transports, ['internal', 'hybrid']);
    const assertion = a.login({ challenge: wa.makeChallenge(SECRET, 'l'), origin: ORIGIN });
    const out = wa.verifyAuthentication({ credential: assertion, stored, checkChallenge: loginCheck, origin: ORIGIN, rpId: RP });
    assert.strictEqual(out.signCount, 0);
  }
});

test('登录：签名被改、来源不对、网站不对、类型不对、没验本人 → 一律不过', () => {
  const { a, stored } = registered();
  const ok = (o) => wa.verifyAuthentication({ credential: o, stored, checkChallenge: loginCheck, origin: ORIGIN, rpId: RP });
  const fresh = (extra = {}) => a.login({ challenge: wa.makeChallenge(SECRET, 'l'), origin: ORIGIN, ...extra });

  const tampered = fresh();
  const sig = Buffer.from(tampered.response.signature, 'base64url');
  sig[sig.length - 1] ^= 1;
  tampered.response.signature = b64u(sig);
  assert.throws(() => ok(tampered), /签名不对/);

  assert.throws(() => ok(fresh({ origin: 'https://evil.example.com' })), /来源不对/);
  assert.throws(() => ok(fresh({ type: 'webauthn.create' })), /类型不对/);
  assert.throws(() => ok(fresh({ flags: 0x01 })), /没验过本人/);
  const other = authenticator('evil.example.com');
  const otherStored = registered().stored; // 另一把钥匙
  assert.throws(() => wa.verifyAuthentication({ credential: other.login({ challenge: wa.makeChallenge(SECRET, 'l'), origin: ORIGIN }), stored: otherStored, checkChallenge: loginCheck, origin: ORIGIN, rpId: RP }), /不是这个网站/);
});

test('挑战：过期、被改、用途不对、绑定的人不对 → 不认', () => {
  const now = Date.now();
  const c = wa.makeChallenge(SECRET, 'l', '', 180, now);
  assert.strictEqual(wa.checkChallenge(SECRET, c, 'l', '', now), true);
  assert.strictEqual(wa.checkChallenge(SECRET, c, 'l', '', now + 181_000), false, '3 分钟后过期');
  assert.strictEqual(wa.checkChallenge(SECRET, c, 'r', '', now), false, '登录的挑战不能拿去开启');
  assert.strictEqual(wa.checkChallenge(Buffer.from('another-secret'), c, 'l', '', now), false, '别的服务器签的不认');
  const r = wa.makeChallenge(SECRET, 'r', 'u0123456789', 180, now);
  assert.strictEqual(wa.checkChallenge(SECRET, r, 'r', 'u0123456789', now), true);
  assert.strictEqual(wa.checkChallenge(SECRET, r, 'r', 'u9999999999', now), false, '给 A 的挑战不能给 B 用');
  const buf = Buffer.from(c, 'base64url');
  buf[0] ^= 1;
  assert.strictEqual(wa.checkChallenge(SECRET, b64u(buf), 'l', '', now), false);
  assert.strictEqual(wa.checkChallenge(SECRET, 'short', 'l', '', now), false);
});

test('开启：没验本人、凭据 ID 对不上、挑战不是开启用的 → 不过', () => {
  const a = authenticator(RP);
  const reg = (extra = {}) => a.register({ challenge: wa.makeChallenge(SECRET, 'r', 'self'), origin: ORIGIN, ...extra });
  const verify = (cred, bind = 'self') => wa.verifyRegistration({ credential: cred, checkChallenge: regCheck(bind), origin: ORIGIN, rpId: RP });
  assert.throws(() => verify(reg({ flags: 0x41 })), /没验过本人/);
  const wrongId = reg();
  wrongId.rawId = b64u(crypto.randomBytes(16));
  assert.throws(() => verify(wrongId), /凭据 ID 对不上/);
  assert.throws(() => verify(reg(), 'u0123456789'), /挑战不对/);
  assert.throws(() => verify(a.register({ challenge: wa.makeChallenge(SECRET, 'l'), origin: ORIGIN })), /挑战不对/);
});

test('计数：认证器报过非 0 的计数，后来变小了 → 当作被复制，不过', () => {
  const { a, stored } = registered();
  const login = (signCount) => a.login({ challenge: wa.makeChallenge(SECRET, 'l'), origin: ORIGIN, signCount });
  const out = wa.verifyAuthentication({ credential: login(5), stored, checkChallenge: loginCheck, origin: ORIGIN, rpId: RP });
  assert.strictEqual(out.signCount, 5);
  assert.throws(() => wa.verifyAuthentication({ credential: login(3), stored: { ...stored, signCount: 5 }, checkChallenge: loginCheck, origin: ORIGIN, rpId: RP }), /计数倒退/);
});

