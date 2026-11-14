'use strict';
// QStash 回调签名：用同样的密钥签出来的才认；改了 body、过期、不是 Upstash 签的都不认
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verify, publish } = require('./qstash.js');

const b64u = (x) => Buffer.from(x).toString('base64url');
function sign(key, claims) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(crypto.createHmac('sha256', key).update(`${h}.${p}`).digest())}`;
}
const body = JSON.stringify({ type: 'record', id: 'recX', slot: '1h' });
const now = Date.parse('2026-10-07T12:00:00Z');
const claims = (o = {}) => ({ iss: 'Upstash', sub: 'https://app.example.com/api/remind', exp: now / 1000 + 300, nbf: now / 1000, body: crypto.createHash('sha256').update(body).digest('base64'), ...o });
const keys = ['sig_current', 'sig_next'];

test('当前或下一把密钥签的都认（body 摘要带不带 = 都行）', () => {
  assert.equal(verify(sign('sig_current', claims()), body, { keys, now }), true);
  assert.equal(verify(sign('sig_next', claims()), body, { keys, now }), true);
});

test('不认：别的密钥、body 被改、过期、不是 Upstash、乱写的签名', () => {
  assert.equal(verify(sign('other', claims()), body, { keys, now }), false);
  assert.equal(verify(sign('sig_current', claims()), body.replace('1h', '12h'), { keys, now }), false);
  assert.equal(verify(sign('sig_current', claims({ exp: now / 1000 - 120 })), body, { keys, now }), false);
  assert.equal(verify(sign('sig_current', claims({ iss: 'someone' })), body, { keys, now }), false);
  assert.equal(verify('abc', body, { keys, now }), false);
  assert.equal(verify('', body, { keys, now }), false);
});

test('预约：目标网址接在 /v2/publish/ 后面，带送达时间、防重复编号、重试次数', async () => {
  Object.assign(process.env, { QSTASH_URL: 'https://qstash.example.io/', QSTASH_TOKEN: 'tok' });
  let seen;
  global.fetch = async (url, init) => ((seen = { url, init }), new Response(JSON.stringify({ messageId: 'msg_1' })));
  const id = await publish('https://app.example.com/api/remind', { a: 1 }, { at: now + 3600e3, dedupId: 'digest-2026-10-07-21' });
  assert.equal(id, 'msg_1');
  assert.equal(seen.url, 'https://qstash.example.io/v2/publish/https://app.example.com/api/remind');
  assert.equal(seen.init.headers['Upstash-Not-Before'], String(now / 1000 + 3600));
  assert.equal(seen.init.headers['Upstash-Deduplication-Id'], 'digest-2026-10-07-21');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
});
