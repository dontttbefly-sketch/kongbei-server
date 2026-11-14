'use strict';
// 备注提醒的回调：签名不对 401；已经写了备注 / 删了 / 是收入就不推；汇总只算没备注的支出；没有设备不推。记账时只给没备注的支出预约
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

Object.assign(process.env, { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 's', BASE_TOKEN: 'base1', TABLE_ID: 'tblLedger', QSTASH_TOKEN: 'qt', QSTASH_URL: 'https://qstash.example.io', QSTASH_CURRENT_SIGNING_KEY: 'k1', QSTASH_NEXT_SIGNING_KEY: 'k2' });
const { generateVapidKeys } = require('./webpush.js');
Object.assign(process.env, (({ publicKey, privateKey }) => ({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: 'https://app.example.com' }))(generateVapidKeys()));
const remind = require('./remind.js');
const feishu = require('./feishu.js');

const b64u = (x) => Buffer.from(x).toString('base64url');
function signed(body, key = 'k1') {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Date.now() / 1000;
  const p = b64u(JSON.stringify({ iss: 'Upstash', exp: now + 300, nbf: now - 1, body: crypto.createHash('sha256').update(body).digest('base64url') }));
  return `${h}.${p}.${b64u(crypto.createHmac('sha256', key).update(`${h}.${p}`).digest())}`;
}
const callback = (msg, key) => {
  const body = JSON.stringify(msg);
  return remind.handle({ method: 'POST', headers: { 'Upstash-Signature': signed(body, key) }, body }).then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));
};

// 假飞书 + 假推送服务（lang：这台设备订阅时选的语言，存在订阅 JSON 里）
function fake({ record, ledger = [], subs = 1, lang }) {
  feishu._reset();
  const pushed = [];
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  Object.assign(pushed, { ua, auth });
  const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) }, ...(lang ? { lang } : {}) };
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (data) => new Response(JSON.stringify({ code: 0, data }));
    if (u.includes('tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }));
    if (u.startsWith('https://web.push.apple.com')) return pushed.push(init), new Response('', { status: 201 });
    if (/\/tables\?/.test(u)) return ok({ items: subs ? [{ table_id: 'tblSubs', name: '提醒订阅' }] : [], has_more: false });
    if (u.includes('/tblSubs/records/search')) return ok({ items: [{ record_id: 'recS', fields: { 订阅: JSON.stringify(sub), 设备: 'iPhone' } }] });
    if (u.includes('/tblLedger/records/search')) return ok({ items: ledger.map((r) => ({ record_id: r.id, fields: { 金额: r.amount, 记账日期: r.time, 账单类目: r.category, 备注: r.note } })) });
    if (u.includes('/tblLedger/records/')) return record ? ok({ record: { fields: { 金额: record.amount, 记账日期: record.time, 账单类目: record.category, 备注: record.note } } }) : new Response(JSON.stringify({ code: 1254043, msg: 'RecordIdNotFound' }));
    throw new Error(`没想到的请求 ${u}`);
  };
  return pushed;
}

test('签名不对：401，不推', async () => {
  const pushed = fake({ record: { amount: -42, time: Date.now(), category: '✨值得体验', note: '' } });
  assert.equal((await callback({ type: 'record', id: 'recA', slot: '1h' }, 'wrong')).status, 401);
  assert.equal(pushed.length, 0);
});

test('一笔：还没备注就推（点开去这一笔）；写了备注、删了、是收入、是一日三餐、是住房就不推', async () => {
  let pushed = fake({ record: { amount: -42, time: Date.now(), category: '✨值得体验', note: '' } });
  const r = await callback({ type: 'record', id: 'recA', slot: '1h' });
  assert.equal(r.sent, 1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].headers['Content-Encoding'], 'aes128gcm');
  fake({ record: { amount: -42, time: Date.now(), category: '✨值得体验', note: '耳机' } });
  assert.equal((await callback({ type: 'record', id: 'recA', slot: '12h' })).skipped, 'has_note');
  fake({ record: null });
  assert.equal((await callback({ type: 'record', id: 'recA', slot: '12h' })).skipped, 'deleted');
  fake({ record: { amount: 13500, time: Date.now(), category: '💳收入', note: '' } });
  assert.equal((await callback({ type: 'record', id: 'recA', slot: '1h' })).skipped, 'has_note');
  fake({ record: { amount: -42, time: Date.now(), category: '🍲一日三餐', note: '' } });
  assert.equal((await callback({ type: 'record', id: 'recA', slot: '1h' })).skipped, 'has_note');
  fake({ record: { amount: -1800, time: Date.now(), category: '🏠住房', note: '' } });
  assert.equal((await callback({ type: 'record', id: 'recA', slot: '1h' })).skipped, 'has_note');
});

test('没有开提醒的设备：不推', async () => {
  fake({ record: { amount: -42, time: Date.now(), category: '✨值得体验', note: '' }, subs: 0 });
  assert.equal((await callback({ type: 'record', id: 'recA', slot: '1h' })).skipped, 'no_device');
});

test('晚 9 点汇总：只算今天没写备注的支出；全写了就不推', async () => {
  const now = Date.now();
  const ledger = [
    { id: 'r1', amount: -42, time: now - 3600e3, category: '✨值得体验', note: '' },
    { id: 'r2', amount: -18, time: now - 1800e3, category: '🛍️生活日常', note: '' },
    { id: 'r5', amount: -30, time: now - 1200e3, category: '🍲一日三餐', note: '' },
    { id: 'r6', amount: -1800, time: now - 1100e3, category: '🏠住房', note: '' },
    { id: 'r3', amount: -99, time: now - 600e3, category: '✨值得体验', note: '耳机' },
    { id: 'r4', amount: 13500, time: now - 900e3, category: '💳收入', note: '' },
  ].filter((r) => r.time >= feishuDayStart(now));
  const pushed = fake({ ledger });
  const r = await callback({ type: 'digest', slot: '21', at: now });
  // 刚过北京时间半夜时，上面几笔有的落在昨天、被筛掉了：按「今天还剩几笔该问的」来对（原来按笔数对，零点后一小时内会误报）
  const due = ledger.filter(remind.needsNote);
  if (due.length) assert.equal(r.sent, 1);
  else assert.equal(r.skipped, 'all_noted');
  assert.equal(pushed.length, due.length ? 1 : 0);
  fake({ ledger: ledger.map((x) => ({ ...x, note: '写了' })) });
  assert.equal((await callback({ type: 'digest', slot: '21', at: now })).skipped, 'all_noted');
});
const feishuDayStart = (ms) => Math.floor((ms + 8 * 3600e3) / 864e5) * 864e5 - 8 * 3600e3;

test('记账时预约：没备注的支出约上（目标是这个域名的 /api/remind）；有备注、收入不约', async () => {
  const published = [];
  global.fetch = async (url, init) => (published.push({ url: String(url), headers: init.headers }), new Response(JSON.stringify({ messageId: 'm' })));
  const n = await remind.scheduleReminders({ id: 'recNew', note: '', category: '✨值得体验', amount: -42 }, 'app.example.com', Date.parse('2026-10-07T14:05:00+08:00'));
  assert.equal(n, 3);
  assert.ok(published.every((p) => p.url === 'https://qstash.example.io/v2/publish/https://app.example.com/api/remind'));
  assert.equal(await remind.scheduleReminders({ id: 'r', note: '耳机', category: '✨值得体验', amount: -42 }, 'app.example.com'), 0);
  assert.equal(await remind.scheduleReminders({ id: 'r', note: '', category: '🍲一日三餐', amount: -42 }, 'app.example.com'), 0, '一日三餐不提醒');
  assert.equal(await remind.scheduleReminders({ id: 'r', note: '', category: '🏠住房', amount: -1800 }, 'app.example.com'), 0, '住房不提醒');
  assert.equal(await remind.scheduleReminders({ id: 'r', note: '', category: '💳收入', amount: 9000 }, 'app.example.com'), 0);
});

// 手机那一端：用设备自己的私钥 + auth 解开推送（RFC 8291，和 webpush.test.js 一样）
function decrypt(buf, ua, auth) {
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

test('设备选了英文：单笔提醒、晚 9 点汇总都用英文推；以前的订阅（没存语言）照旧中文', async () => {
  const han = /[\u4e00-\u9fff]/;
  let pushed = fake({ record: { amount: -42, time: Date.now(), category: '✨值得体验', note: '' }, lang: 'en' });
  assert.equal((await callback({ type: 'record', id: 'recA', slot: '1h' })).sent, 1);
  const msg = decrypt(Buffer.from(pushed[0].body), pushed.ua, pushed.auth);
  assert.ok(!han.test(msg.title + msg.body), msg.body);
  assert.match(msg.body, /¥42/);
  assert.equal(msg.url, '/?fill=recA');

  const now = Date.now();
  const ledger = [
    { id: 'r1', amount: -42, time: now - 2000, category: '✨值得体验', note: '' },
    { id: 'r2', amount: -18, time: now - 1000, category: '🛍️生活日常', note: '' },
  ];
  pushed = fake({ ledger, lang: 'en' });
  assert.equal((await callback({ type: 'digest', slot: '21', at: now })).sent, 1);
  const digest = decrypt(Buffer.from(pushed[0].body), pushed.ua, pushed.auth);
  assert.ok(!han.test(digest.title + digest.body), digest.body);

  pushed = fake({ record: { amount: -42, time: Date.now(), category: '✨值得体验', note: '' } });
  await callback({ type: 'record', id: 'recA', slot: '1h' });
  assert.ok(han.test(decrypt(Buffer.from(pushed[0].body), pushed.ua, pushed.auth).body), '没存语言的老订阅：中文');
});
