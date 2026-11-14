'use strict';
// 空杯记账 · 面容 ID 登录（WebAuthn 通行密钥）的验签。零依赖：只用 node:crypto
//
// 只要「none」证明（开启时 attestation: 'none'）：不管是哪家的认证器，只记下它给的公钥；之后每次登录用这把公钥验签。
// 算法：ES256（-7，iPhone、Mac、安卓都是它）、RS256（-257，部分 Windows Hello）、EdDSA（-8）
// 挑战不用存：16 字节随机 + 过期时刻 + HMAC（用途、绑定的人一起签进去），回来时验 HMAC 和有没有过期

const crypto = require('node:crypto');

class WebAuthnError extends Error {}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s ?? ''), 'base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

// ── 极简 CBOR 解码：WebAuthn 只用到整数、字节串、文本串、数组、映射、true/false/null ──
function decodeCbor(buf) {
  let pos = 0;
  const need = (n) => {
    if (pos + n > buf.length) throw new WebAuthnError('CBOR 数据不完整');
  };
  const read = () => {
    need(1);
    const ib = buf[pos++];
    const major = ib >> 5;
    const info = ib & 0x1f;
    let len;
    if (info < 24) len = info;
    else if (info === 24) (need(1), (len = buf[pos]), (pos += 1));
    else if (info === 25) (need(2), (len = buf.readUInt16BE(pos)), (pos += 2));
    else if (info === 26) (need(4), (len = buf.readUInt32BE(pos)), (pos += 4));
    else if (info === 27) {
      need(8);
      const big = buf.readBigUInt64BE(pos);
      pos += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError('CBOR 数字太大');
      len = Number(big);
    } else throw new WebAuthnError('CBOR：不支持不定长编码');
    switch (major) {
      case 0:
        return len;
      case 1:
        return -1 - len;
      case 2: {
        need(len);
        const v = Buffer.from(buf.subarray(pos, pos + len));
        pos += len;
        return v;
      }
      case 3: {
        need(len);
        const v = buf.subarray(pos, pos + len).toString('utf8');
        pos += len;
        return v;
      }
      case 4: {
        const a = [];
        for (let i = 0; i < len; i++) a.push(read());
        return a;
      }
      case 5: {
        const m = new Map();
        for (let i = 0; i < len; i++) {
          const k = read();
          m.set(k, read());
        }
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new WebAuthnError('CBOR：不支持的简单值');
      default:
        throw new WebAuthnError(`CBOR：不支持的类型 ${major}`);
    }
  };
  const value = read();
  return { value, length: pos };
}

// ── 认证器数据：rpId 摘要(32) | 标志(1) | 计数(4) | [AAGUID(16) | 凭据 ID 长度(2) | 凭据 ID | 公钥(COSE)] ──
function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw new WebAuthnError('认证器数据太短');
  const flags = buf[32];
  const out = {
    rpIdHash: buf.subarray(0, 32),
    flags,
    up: !!(flags & 0x01), // 有人在场（点了 / 看了一眼）
    uv: !!(flags & 0x04), // 验过本人（面容、指纹、密码）
    at: !!(flags & 0x40), // 带着新凭据（只有开启时有）
    signCount: buf.readUInt32BE(33),
  };
  if (out.at) {
    let p = 37;
    if (buf.length < p + 18) throw new WebAuthnError('认证器数据不完整');
    p += 16; // AAGUID：只要 none 证明，不看是哪家的认证器
    const idLen = buf.readUInt16BE(p);
    p += 2;
    if (buf.length < p + idLen) throw new WebAuthnError('凭据 ID 不完整');
    out.credentialId = Buffer.from(buf.subarray(p, p + idLen));
    p += idLen;
    out.coseKey = decodeCbor(buf.subarray(p)).value;
  }
  return out;
}

// COSE 公钥 → { alg, jwk }（jwk 能直接 crypto.createPublicKey 用；只存公钥，不是秘密）
function coseToJwk(m) {
  if (!(m instanceof Map)) throw new WebAuthnError('公钥格式不对');
  const kty = m.get(1);
  const alg = m.get(3);
  let out;
  if (kty === 2 && m.get(-1) === 1 && (alg ?? -7) === -7) out = { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2)), y: b64u(m.get(-3)) } };
  else if (kty === 3 && (alg ?? -257) === -257) out = { alg: -257, jwk: { kty: 'RSA', n: b64u(m.get(-1)), e: b64u(m.get(-2)) } };
  else if (kty === 1 && m.get(-1) === 6 && (alg ?? -8) === -8) out = { alg: -8, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(m.get(-2)) } };
  else throw new WebAuthnError(`不支持的公钥（kty ${kty}，alg ${alg}）`);
  crypto.createPublicKey({ key: out.jwk, format: 'jwk' }); // 能导入才算数
  return out;
}

function verifySignature(alg, jwk, data, sig) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  try {
    if (alg === -7) return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig);
    if (alg === -257) return crypto.verify('sha256', data, key, sig);
    if (alg === -8) return crypto.verify(null, data, key, sig);
  } catch {
    return false;
  }
  return false;
}

// 浏览器签进去的 clientDataJSON：类型、挑战、来源都要对得上
function checkClientData(raw, type, checkChallenge, origin) {
  let c;
  try {
    c = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    throw new WebAuthnError('clientDataJSON 不是 JSON');
  }
  if (c.type !== type) throw new WebAuthnError(`类型不对：${c.type}`);
  if (typeof c.challenge !== 'string' || !checkChallenge(c.challenge)) throw new WebAuthnError('挑战不对或已过期');
  if (c.origin !== origin) throw new WebAuthnError(`来源不对：${c.origin}`);
  if (c.crossOrigin === true) throw new WebAuthnError('不接受跨站');
  return c;
}

// 开启：验浏览器回来的 attestation，拿出凭据 ID 和公钥
function verifyRegistration({ credential, checkChallenge, origin, rpId }) {
  const r = credential?.response;
  if (!r?.clientDataJSON || !r?.attestationObject) throw new WebAuthnError('缺少凭据数据');
  checkClientData(fromB64u(r.clientDataJSON), 'webauthn.create', checkChallenge, origin);
  const att = decodeCbor(fromB64u(r.attestationObject)).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new WebAuthnError('attestationObject 格式不对');
  const auth = parseAuthData(att.get('authData'));
  if (!auth.rpIdHash.equals(sha256(rpId))) throw new WebAuthnError('不是这个网站的凭据');
  if (!auth.up || !auth.uv) throw new WebAuthnError('没验过本人（面容 / 指纹）');
  if (!auth.at || !auth.credentialId) throw new WebAuthnError('没带凭据');
  const id = b64u(auth.credentialId);
  if (credential.rawId && b64u(fromB64u(credential.rawId)) !== id) throw new WebAuthnError('凭据 ID 对不上');
  const { alg, jwk } = coseToJwk(auth.coseKey);
  const transports = Array.isArray(r.transports) ? r.transports.filter((t) => typeof t === 'string').slice(0, 6) : [];
  return { id, alg, jwk, signCount: auth.signCount, transports };
}

// 登录：用记下的公钥验签。返回新的计数（iCloud 钥匙串的通行密钥计数一直是 0，那就不比）
function verifyAuthentication({ credential, stored, checkChallenge, origin, rpId }) {
  const r = credential?.response;
  if (!r?.clientDataJSON || !r?.authenticatorData || !r?.signature) throw new WebAuthnError('缺少签名数据');
  const clientData = fromB64u(r.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', checkChallenge, origin);
  const authData = fromB64u(r.authenticatorData);
  const auth = parseAuthData(authData);
  if (!auth.rpIdHash.equals(sha256(rpId))) throw new WebAuthnError('不是这个网站的凭据');
  if (!auth.up || !auth.uv) throw new WebAuthnError('没验过本人（面容 / 指纹）');
  const ok = verifySignature(stored.alg, stored.jwk, Buffer.concat([authData, sha256(clientData)]), fromB64u(r.signature));
  if (!ok) throw new WebAuthnError('签名不对');
  if ((stored.signCount || auth.signCount) && auth.signCount <= (stored.signCount || 0)) throw new WebAuthnError('计数倒退：这把通行密钥可能被复制了');
  return { signCount: auth.signCount };
}

// ── 挑战：16 字节随机 | 过期时刻(4) | HMAC 前 16 字节。用途 r = 开启（绑定到这个人）、l = 登录 ──
function makeChallenge(secret, purpose, bind = '', ttlSec = 180, now = Date.now()) {
  const nonce = crypto.randomBytes(16);
  const exp = Buffer.alloc(4);
  exp.writeUInt32BE(Math.floor(now / 1000) + ttlSec);
  const mac = crypto.createHmac('sha256', secret).update(Buffer.concat([nonce, exp, Buffer.from(`${purpose}|${bind}`)])).digest().subarray(0, 16);
  return b64u(Buffer.concat([nonce, exp, mac]));
}

function checkChallenge(secret, challenge, purpose, bind = '', now = Date.now()) {
  const buf = fromB64u(challenge);
  if (buf.length !== 36 || b64u(buf) !== challenge) return false;
  const nonce = buf.subarray(0, 16);
  const exp = buf.subarray(16, 20);
  const want = crypto.createHmac('sha256', secret).update(Buffer.concat([nonce, exp, Buffer.from(`${purpose}|${bind}`)])).digest().subarray(0, 16);
  if (!crypto.timingSafeEqual(buf.subarray(20), want)) return false;
  return exp.readUInt32BE(0) >= Math.floor(now / 1000);
}

// 挑战里的随机数：用过的记一下，防同一个登录签名被重放
const challengeNonce = (challenge) => b64u(fromB64u(challenge).subarray(0, 16));

module.exports = {
  WebAuthnError,
  b64u,
  fromB64u,
  sha256,
  decodeCbor,
  parseAuthData,
  coseToJwk,
  verifySignature,
  verifyRegistration,
  verifyAuthentication,
  makeChallenge,
  checkChallenge,
  challengeNonce,
};
