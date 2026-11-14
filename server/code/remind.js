'use strict';
// 空杯记账 · 备注提醒（2026-10-07）：
//   1. 记账接口写好一笔没写备注的账 → scheduleReminders() 向 QStash 预约（排期见 remind-plan.js）
//   2. 到点 QStash 回调 POST /api/remind（带签名）→ 先看这笔现在还有没有备注、有没有开了提醒的设备，再推
// 回调失败（飞书出错）返回 500，QStash 会重试；签名不对 401；不用推（已经写了备注、没设备）照样 200

const qstash = require('./qstash.js');
const { vapidFromEnv } = require('./webpush.js');
const { call, tables, search, cellText, env, FeishuError } = require('./feishu.js');
const { planReminders, recordMessage, digestMessage, atHour, DAY } = require('./remind-plan.js');
const { listSubs, sendToAll } = require('./push.js');
const { getSettings } = require('./settings.js');
const { canonicalCategory } = require('./category-sync.js');
const { isSaas, currentTenant, loadTenant, contextFromRecord, runWithTenant } = require('./tenant.js');

const F = { amount: '金额', time: '记账日期', category: '账单类目', note: '备注' };
// 不问的类：收入（工资、退款一看就知道）；一日三餐（2026-10-07 用户：「通知只通知一日三餐之外的」）；住房（同日用户：「住房也不需要发送通知提醒」）
const NO_ASK = new Set(['💳收入', '🍲一日三餐', '🏠住房']);
const NOT_FOUND = 1254043;

// 只问支出（退款一看就知道是什么）；NO_ASK 那几类不问，汇总里也不算
const needsNote = (r) => r && !String(r.note || '').trim() && !NO_ASK.has(r.category) && r.amount < 0;

function toRecord(id, f) {
  return { id, amount: Number(f[F.amount]) || 0, time: Number(f[F.time]) || 0, category: cellText(f[F.category]), note: cellText(f[F.note]) };
}

async function getRecord(id) {
  try {
    const d = await call(`${tables()}/${env('TABLE_ID')}/records/${id}`);
    return toRecord(id, d.record?.fields || {});
  } catch (e) {
    if (e instanceof FeishuError && e.code === NOT_FOUND) return null; // 在飞书里删掉了
    throw e;
  }
}

// 某个时刻起、到现在为止还没写备注的支出（汇总用），按时间先后
async function unnotedSince(startMs, now = Date.now()) {
  const settings = await getSettings(0);
  const items = await search(env('TABLE_ID'), {
    field_names: Object.values(F),
    filter: { conjunction: 'and', conditions: [{ field_name: F.time, operator: 'isGreater', value: ['ExactDate', String(startMs - DAY)] }] },
  });
  return items
    .map((it) => toRecord(it.record_id, it.fields || {}))
    .map((r) => ({ ...r, category: canonicalCategory(r.category, settings.names, settings.aliases) }))
    .filter((r) => r.time >= startMs && r.time <= now && needsNote(r))
    .sort((a, b) => a.time - b.time);
}

// 记账接口调：预约这一笔的提醒。没配推送或定时器、有备注、是收入，都不预约。返回约上了几条
async function scheduleReminders({ id, note, category, amount }, host, now = Date.now()) {
  if (!id || !host || !qstash.configured() || !vapidFromEnv()) return 0;
  if (!needsNote({ note, category, amount })) return 0;
  // 线上版：把租户 ID 带在回调地址上，到点用它恢复租户上下文（调用方靠 QStash 签名保护）
  const tid = isSaas() ? currentTenant()?.tenant?.id : '';
  const url = `https://${host}/api/remind${tid ? `?tid=${encodeURIComponent(tid)}` : ''}`;
  const plan = planReminders(id, now);
  const res = await Promise.allSettled(plan.map((p) => qstash.publish(url, p.body, { at: p.at, dedupId: p.dedupId })));
  res.forEach((r) => r.status === 'rejected' && console.error('预约提醒失败', r.reason?.message));
  return res.filter((r) => r.status === 'fulfilled').length;
}

function reply(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

async function handle(event) {
  if (event.method !== 'POST') return reply(405, { ok: false });
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (!qstash.verify(headers['upstash-signature'], event.body || '')) return reply(401, { ok: false, error: 'bad_signature' });

  // 开源版：环境变量就是唯一账本，直接执行
  if (!isSaas()) return runRemind(event);

  // 线上版：从预约时带上的 tid 恢复租户上下文（QStash 回调不带用户口令，签名已验证来源）
  const q = event.queryParameters || event.query || {};
  const tid = String(q.tid || '').trim();
  if (!tid) return reply(200, { ok: true, skipped: 'no_tenant' }); // 老预约（升级前约的）没有 tid，跳过不重试
  let rec = null;
  try {
    rec = await loadTenant(tid);
  } catch (e) {
    console.error(e);
    return reply(500, { ok: false, error: 'store_error' }); // 让 QStash 过一会儿重试
  }
  if (!rec) return reply(200, { ok: true, skipped: 'tenant_gone' }); // 租户被解绑了，别再重试
  return runWithTenant(contextFromRecord(rec), () => runRemind(event));
}

async function runRemind(event) {
  let msg;
  try {
    msg = JSON.parse(event.body || '{}');
  } catch {
    return reply(200, { ok: true, skipped: 'bad_json' }); // 不让 QStash 重试一条坏消息
  }
  try {
    if (!vapidFromEnv()) return reply(200, { ok: true, skipped: 'no_vapid' });
    const subs = await listSubs();
    if (!subs.length) return reply(200, { ok: true, skipped: 'no_device' });
    const now = Date.now();
    let payload;
    if (msg.type === 'record') {
      const r = await getRecord(msg.id);
      const st = await getSettings(0);
      if (r) r.category = canonicalCategory(r.category, st.names, st.aliases);
      if (!needsNote(r)) return reply(200, { ok: true, skipped: r ? 'has_note' : 'deleted' });
      const gains = st?.gains ?? {};
      const names = st?.names ?? {}; // 改过的分类名（2026-10-17）：英文问法里提到类目时用用户起的名字
      // 按每台设备选的语言现做（中文 / 英文各做一次）
      payload = (lang) => ({ ...recordMessage(msg.slot, r, now, Math.random, gains, lang, names), url: `/?fill=${encodeURIComponent(r.id)}`, tag: `rec-${r.id}` });
    } else if (msg.type === 'digest') {
      // 晚 9 点：今天的；早 8 点：昨天 0 点起到现在的
      const at = Number(msg.at) || now;
      const start = msg.slot === '21' ? atHour(at, 0) : atHour(at, 0) - DAY;
      const list = await unnotedSince(start, now);
      if (!list.length) return reply(200, { ok: true, skipped: 'all_noted' });
      payload = (lang) => ({ ...digestMessage(msg.slot, list, now, Math.random, lang), url: `/?fill=${encodeURIComponent(list[0].id)}`, tag: 'digest' });
    } else return reply(200, { ok: true, skipped: 'unknown_type' });
    const results = await sendToAll(payload, subs);
    return reply(200, { ok: true, sent: results.filter((r) => r.ok).length, results });
  } catch (e) {
    console.error(e);
    return reply(500, { ok: false, error: e.message }); // 让 QStash 过一会儿重试
  }
}

module.exports = { handle, scheduleReminders, needsNote, unnotedSince, NO_ASK };
