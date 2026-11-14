'use strict';
// 空杯记账 · 推送订阅（备注提醒的开关）：看板凭访问口令开 / 关 / 试推。订阅存在飞书里自动建的「提醒订阅」表（一台设备一行）
//
// POST /api/push   Content-Type: text/plain
//   {"token", "op": "config"}                      → {"ok", "publicKey": VAPID 公钥 | null, "ready": 推送和定时器都配好了}
//   {"token", "op": "subscribe", "subscription", "device", "lang"} → 记下这台设备（lang：这台设备选的界面语言 zh / en，推送跟着它）
//   {"token", "op": "unsubscribe", "endpoint"}     → 删掉这台设备
//   {"token", "op": "test"}                         → 马上给所有设备推一条试试

const { safeEqual } = require('./index.js');
const { findTable, search, call, tables, cellText } = require('./feishu.js');
const { configOf } = require('./tenant.js');
const { withTenant, membershipExpired, EXPIRED_BODY } = require('./saas.js');
const { sendPush, vapidFromEnv } = require('./webpush.js');
const qstash = require('./qstash.js');
const { recordMessage } = require('./remind-plan.js');

const TABLE = '提醒订阅';
const FIELDS = [
  { field_name: '端点', type: 1 },
  { field_name: '订阅', type: 1 },
  { field_name: '设备', type: 1 },
  { field_name: '更新时间', type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
];
const AUTH_FAIL_DELAY_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 推送的语言：存在「订阅」那一格的 JSON 里（{endpoint, keys, lang}），不另加字段——已经建好的表没有那一列。
// 只认 zh / en；以前存的没有 lang，当中文
const langOf = (x) => (x === 'en' ? 'en' : 'zh');

async function listSubs() {
  const t = await findTable(TABLE);
  if (!t) return [];
  const items = await search(t, { field_names: ['订阅', '设备'] });
  return items.flatMap((it) => {
    try {
      const sub = JSON.parse(cellText(it.fields['订阅']));
      return sub?.endpoint ? [{ recordId: it.record_id, sub, device: cellText(it.fields['设备']), lang: langOf(sub.lang) }] : [];
    } catch {
      return [];
    }
  });
}

async function saveSub(sub, device) {
  const t = await findTable(TABLE, FIELDS);
  const fields = { 端点: sub.endpoint, 订阅: JSON.stringify(sub), 设备: String(device || '').slice(0, 80), 更新时间: Date.now() };
  const same = (await listSubs()).find((x) => x.sub.endpoint === sub.endpoint);
  if (same) await call(`${tables()}/${t}/records/${same.recordId}`, { method: 'PUT', body: { fields } });
  else await call(`${tables()}/${t}/records`, { method: 'POST', body: { fields } });
}

async function removeSub(recordId) {
  const t = await findTable(TABLE);
  if (t) await call(`${tables()}/${t}/records/${recordId}`, { method: 'DELETE' });
}

// 推给所有设备；推送服务说这个订阅没了（404 / 410）就顺手删掉。
// payload：所有设备同一条（对象），或者按设备的语言现做（函数 lang => payload；每种语言只做一次，同一种语言的设备收到同一句）
async function sendToAll(payload, subs) {
  const vapid = vapidFromEnv();
  if (!vapid) return [];
  const list = subs ?? (await listSubs());
  const made = new Map();
  const payloadFor = (lang) => {
    if (typeof payload !== 'function') return payload;
    if (!made.has(lang)) made.set(lang, payload(lang));
    return made.get(lang);
  };
  const results = await Promise.all(list.map((s) => sendPush(s.sub, payloadFor(s.lang ?? langOf(s.sub?.lang)), vapid).catch((e) => ({ status: 0, gone: false, text: e.message }))));
  await Promise.all(list.map((s, i) => (results[i].gone ? removeSub(s.recordId).catch(() => {}) : null)));
  return results.map((r, i) => ({ device: list[i].device, status: r.status, ok: r.status >= 200 && r.status < 300, ...(r.text ? { error: r.text } : {}) }));
}

function validSub(s) {
  return s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
}

function reply(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

async function handle(event) {
  if (event.method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' });
  let req;
  try {
    req = JSON.parse(event.body || '{}');
  } catch {
    return reply(400, { ok: false, error: 'bad_json' });
  }
  const want = configOf('API_TOKEN');
  if (!want || !req?.token || !safeEqual(req.token, want)) {
    await sleep(AUTH_FAIL_DELAY_MS);
    return reply(401, { ok: false, error: 'unauthorized' });
  }
  const vapid = vapidFromEnv();
  try {
    switch (req.op) {
      case 'config':
        return reply(200, { ok: true, publicKey: vapid?.publicKey ?? null, ready: !!vapid && qstash.configured() });
      case 'subscribe':
        if (membershipExpired()) return reply(402, EXPIRED_BODY); // 线上版：会员过期不能开新提醒（关提醒随时可以）
        if (!vapid) return reply(503, { ok: false, error: 'not_configured', message: '服务器还没配推送密钥（VAPID）' });
        if (!validSub(req.subscription)) return reply(400, { ok: false, error: 'bad_subscription' });
        await saveSub({ endpoint: req.subscription.endpoint, keys: { p256dh: req.subscription.keys.p256dh, auth: req.subscription.keys.auth }, lang: langOf(req.lang) }, req.device);
        return reply(200, { ok: true });
      case 'unsubscribe': {
        const same = (await listSubs()).filter((x) => x.sub.endpoint === req.endpoint);
        for (const s of same) await removeSub(s.recordId);
        return reply(200, { ok: true, removed: same.length });
      }
      case 'test': {
        if (membershipExpired()) return reply(402, EXPIRED_BODY);
        const results = await sendToAll((lang) => {
          const sample = recordMessage('1h', { amount: -28.5, category: '✨值得体验', time: Date.now() }, Date.now(), Math.random, {}, lang);
          return { title: sample.title, body: lang === 'en' ? `${sample.body} (This is a test.)` : `${sample.body}（这是一条试推）`, url: '/', tag: 'test' };
        });
        return reply(200, { ok: true, sent: results.filter((r) => r.ok).length, results });
      }
      default:
        return reply(400, { ok: false, error: 'bad_op' });
    }
  } catch (e) {
    console.error(e);
    return reply(502, { ok: false, error: 'push_error', message: e.message });
  }
}

// 双轨入口：线上版先解析租户、注入上下文。读配置、关提醒随时可以；开提醒、试推要会员有效（上面 op 里判断）——
// 整个接口按写操作挡掉的话，会员过期的人连提醒都关不掉
module.exports = { handle: withTenant(handle), listSubs, sendToAll, validSub, langOf };
