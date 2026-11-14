'use strict';
// Web Push：VAPID 的 JWT 能用公钥验过；加密后按 RFC 8291 的步骤解得开（模拟手机那一端）
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { generateVapidKeys, vapidAuth, encrypt, b64u, unb64u } = require('./webpush.js');

test('VAPID：aud 是推送服务的域名、12 小时内过期、签名用公钥验得过', () => {
  const keys = generateVapidKeys();
  const now = Date.parse('2026-10-07T12:00:00Z');
  const h = vapidAuth('https://web.push.apple.com/QGuQyavXutnMH', { ...keys, subject: 'https://app.example.com' }, now);
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.equal(k, keys.publicKey);
  const [hd, pl, sig] = t.split('.');
  const claims = JSON.parse(unb64u(pl));
  assert.deepEqual(claims, { aud: 'https://web.push.apple.com', exp: now / 1000 + 43200, sub: 'https://app.example.com' });
  const pub = unb64u(keys.publicKey);
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${pl}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, unb64u(sig)));
});

test('aes128gcm：手机那一端（自己的私钥 + auth）按 RFC 8291 解得开，内容一字不差', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const msg = { title: '叮～', body: '刚刚那笔 ¥28.5 是干嘛啦？', url: '/?fill=recABC' };
  const out = encrypt(JSON.stringify(msg), { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) });
  // 头：salt(16) + rs(4) + idlen(1) + 服务器的临时公钥(65)
  const salt = out.subarray(0, 16);
  assert.equal(out.readUInt32BE(16), 4096);
  const idlen = out[20];
  assert.equal(idlen, 65);
  const asPublic = out.subarray(21, 21 + idlen);
  const ct = out.subarray(21 + idlen);
  const secret = ua.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, '最后一条记录的分隔符');
  assert.deepEqual(JSON.parse(plain.subarray(0, -1)), msg);
});
