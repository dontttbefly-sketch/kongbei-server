'use strict';
// 空杯记账 · Web Push（备注提醒用）：VAPID 签名（RFC 8292）+ aes128gcm 加密（RFC 8291），只用 Node 自带的 crypto，不加依赖。
// iPhone 主屏幕上的网页 App（iOS 16.4 起）、Mac / 电脑浏览器都走这一套。
//   环境变量：VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（base64url；生成一对：node -e "console.log(require('./server/code/webpush.js').generateVapidKeys())"）、
//   VAPID_SUBJECT（https://你的域名 或 mailto:…）

const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// 一对新的 VAPID 密钥：公钥是 65 字节的未压缩点，私钥是 32 字节
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// 原始公私钥 → Node 能用的 KeyObject（JWK）
function privateKeyObject(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(unb64u(privateKey)) }, format: 'jwk' });
}

// VAPID：给推送服务（Apple / Google / Mozilla）看的 JWT，ES256，12 小时有效
function vapidAuth(endpoint, { publicKey, privateKey, subject }, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKeyObject(publicKey, privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${publicKey}`;
}

// aes128gcm 加密：订阅里的 p256dh（手机的公钥）+ auth（共享密钥）→ 只有那台设备解得开
function encrypt(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), serverEcdh } = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const as = serverEcdh ?? crypto.createECDH('prime256v1');
  if (!serverEcdh) as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// 发一条。返回推送服务的 HTTP 状态：201 成功；404 / 410 = 这个订阅没了（关了通知、删了 App），该删掉
async function sendPush(subscription, data, vapid, { ttl = 12 * 3600, urgency = 'normal' } = {}) {
  const body = encrypt(JSON.stringify(data), subscription.keys);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuth(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, gone: res.status === 404 || res.status === 410, text: res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200) };
}

function vapidFromEnv() {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = process.env;
  return publicKey && privateKey ? { publicKey, privateKey, subject: subject || 'mailto:noreply@example.com' } : null;
}

module.exports = { generateVapidKeys, vapidAuth, encrypt, sendPush, vapidFromEnv, b64u, unb64u };
