'use strict';
// 推送订阅：订阅时记下这台设备选的语言（存在「订阅」那格的 JSON 里，不加新字段）；推的时候每台设备按自己的语言收
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

Object.assign(process.env, { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 's', BASE_TOKEN: 'base1', TABLE_ID: 'tblLedger', API_TOKEN: 'view-token' });
const { generateVapidKeys } = require('./webpush.js');
Object.assign(process.env, (({ publicKey, privateKey }) => ({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: 'https://app.example.com' }))(generateVapidKeys()));
const push = require('./push.js');
const feishu = require('./feishu.js');

const b64u = (x) => Buffer.from(x).toString('base64url');
function device(name) {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, sub: { endpoint: `https://push.example/${name}`, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } } };
}
// 手机那一端解开推送（RFC 8291）
function decrypt(buf, { ua, auth }) {
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).subarray(0, -1));
}

// 假飞书（「提醒订阅」表存在内存里）+ 假推送服务
function fake(rows = []) {
  feishu._reset();
  const store = rows.map((fields, i) => ({ record_id: `rec${i + 1}`, fields }));
  const pushed = {};
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (data) => new Response(JSON.stringify({ code: 0, data }));
    if (u.includes('tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }));
    if (u.startsWith('https://push.example/')) return (pushed[u.split('/').pop()] = Buffer.from(init.body)), new Response('', { status: 201 });
    if (/\/tables\?/.test(u)) return ok({ items: [{ table_id: 'tblSubs', name: '提醒订阅' }], has_more: false });
    if (u.includes('/tblSubs/records/search')) return ok({ items: store.map((r) => ({ record_id: r.record_id, fields: r.fields })), has_more: false });
    if (init.method === 'POST' && u.endsWith('/tblSubs/records')) return store.push({ record_id: `rec${store.length + 1}`, fields: JSON.parse(init.body).fields }), ok({ record: {} });
    if (init.method === 'PUT' && /\/tblSubs\/records\/rec\d+$/.test(u)) {
      store.find((r) => r.record_id === u.split('/').pop()).fields = JSON.parse(init.body).fields;
      return ok({ record: {} });
    }
    throw new Error(`没想到的请求 ${init.method || 'GET'} ${u}`);
  };
  return { store, pushed };
}
const call = (body) => push.handle({ method: 'POST', headers: {}, body: JSON.stringify({ token: 'view-token', ...body }) }).then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));
const stored = (row) => JSON.parse(row.fields['订阅']);

test('订阅：记下这台设备选的语言；只认 zh / en，别的当中文；同一台设备再订一次就更新语言', async () => {
  const { store } = fake();
  const a = device('a');
  assert.equal((await call({ op: 'subscribe', subscription: a.sub, device: 'iPhone', lang: 'en' })).status, 200);
  assert.equal(store.length, 1);
  assert.equal(stored(store[0]).lang, 'en');
  assert.deepEqual(Object.keys(store[0].fields).sort(), ['更新时间', '端点', '订阅', '设备'].sort(), '没有加新字段');

  await call({ op: 'subscribe', subscription: device('b').sub, device: 'Mac', lang: 'fr' });
  await call({ op: 'subscribe', subscription: device('c').sub, device: 'Mac' });
  assert.deepEqual(store.map((r) => stored(r).lang), ['en', 'zh', 'zh']);

  await call({ op: 'subscribe', subscription: a.sub, device: 'iPhone', lang: 'zh' });
  assert.equal(store.length, 3, '同一个端点是更新，不是再加一行');
  assert.equal(stored(store[0]).lang, 'zh');
});

test('listSubs：带上每台设备的语言；以前存的（没有 lang）当中文', async () => {
  const a = device('a');
  const b = device('b');
  fake([{ 订阅: JSON.stringify(a.sub), 设备: 'iPhone' }, { 订阅: JSON.stringify({ ...b.sub, lang: 'en' }), 设备: 'Mac' }]);
  const subs = await push.listSubs();
  assert.deepEqual(subs.map((s) => [s.device, s.lang]), [['iPhone', 'zh'], ['Mac', 'en']]);
});

test('sendToAll：传一个按语言现做的函数——每种语言只做一次，每台设备收到自己语言的那条；传对象照旧所有设备同一条', async () => {
  const zh1 = device('zh1');
  const en1 = device('en1');
  const zh2 = device('zh2');
  const { pushed } = fake([{ 订阅: JSON.stringify(zh1.sub), 设备: 'iPhone' }, { 订阅: JSON.stringify({ ...en1.sub, lang: 'en' }), 设备: 'Mac' }, { 订阅: JSON.stringify({ ...zh2.sub, lang: 'zh' }), 设备: 'iPad' }]);
  const made = [];
  const results = await push.sendToAll((lang) => (made.push(lang), { title: lang === 'en' ? 'Hi' : '你好', body: `${lang}-${made.length}`, url: '/' }));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.deepEqual(made.sort(), ['en', 'zh'], '每种语言只做一次');
  const got = { zh1: decrypt(pushed.zh1, zh1), en1: decrypt(pushed.en1, en1), zh2: decrypt(pushed.zh2, zh2) };
  assert.equal(got.zh1.title, '你好');
  assert.equal(got.en1.title, 'Hi');
  assert.equal(got.zh2.body, got.zh1.body, '同一种语言的设备收到同一句');

  const again = fake([{ 订阅: JSON.stringify({ ...en1.sub, lang: 'en' }), 设备: 'Mac' }]);
  await push.sendToAll({ title: '固定', body: '一样', url: '/' });
  assert.equal(decrypt(again.pushed.en1, en1).title, '固定', '传对象：不分语言');
});

test('试推：英文设备收到英文（带 This is a test），中文设备收到中文（带 这是一条试推）', async () => {
  const zh = device('zh');
  const en = device('en');
  const { pushed } = fake([{ 订阅: JSON.stringify(zh.sub), 设备: 'iPhone' }, { 订阅: JSON.stringify({ ...en.sub, lang: 'en' }), 设备: 'Mac' }]);
  const out = await call({ op: 'test' });
  assert.equal(out.sent, 2);
  const enMsg = decrypt(pushed.en, en);
  assert.match(enMsg.body, /\(This is a test\.\)$/);
  assert.ok(!/[一-鿿]/.test(enMsg.title + enMsg.body), enMsg.body);
  assert.match(decrypt(pushed.zh, zh).body, /（这是一条试推）$/);
});
