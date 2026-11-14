'use strict';
// 空杯记账 · 读接口逻辑。线上由 Vercel 函数 api/records.js 转接调用（事件格式沿用阿里云 HTTP 触发器那一套）。
// 页面和接口同源，下面的 CORS 处理已用不上，留着无害
//
// POST /api/records   Content-Type: text/plain
//   body: {"token": "...", "from": "2026-08-01"}   from 省略 = 全量
//   resp: {"ok": true, "from": "...", "count": n, "records": [{id, time, amount, category, note, review}], "syncedAt": ms}

const crypto = require('crypto');
const { configOf, cacheKey } = require('./tenant.js');
const { withTenant } = require('./saas.js');

const FEISHU = 'https://open.feishu.cn/open-apis';
const TZ_OFFSET_MS = 8 * 3600 * 1000; // 记账按东八区算“哪天”
const DAY_MS = 24 * 3600 * 1000;
const FIELDS = { amount: '金额', category: '账单类目', time: '记账日期', note: '备注', review: '复盘' };

// 双轨：线上版从租户上下文取（tenant.js 注入），开源版回退 process.env
const env = (k) => {
  const v = configOf(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

// 实例存活期间复用 tenant_access_token（该接口不计入飞书 API 调用额度）。
// 按 cacheKey 隔离：同一个函数实例可能先后服务多个租户，token 绝不能串
const tokenCaches = new Map();
function tokenSlot() {
  const k = cacheKey();
  let slot = tokenCaches.get(k);
  if (!slot) tokenCaches.set(k, (slot = { value: '', expiresAt: 0 }));
  return slot;
}

async function tenantToken() {
  const slot = tokenSlot();
  if (slot.value && Date.now() < slot.expiresAt) return slot.value;
  const res = await fetch(`${FEISHU}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env('FEISHU_APP_ID'), app_secret: env('FEISHU_APP_SECRET') }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new FeishuError('token', data);
  slot.value = data.tenant_access_token;
  slot.expiresAt = Date.now() + (data.expire - 300) * 1000;
  return slot.value;
}

class FeishuError extends Error {
  constructor(step, data) {
    super(`feishu ${step} failed: code=${data.code} msg=${data.msg}`);
    this.feishuCode = data.code;
  }
}

// "2026-08-01" → 东八区当天 00:00 的毫秒时间戳
function dayStartMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - TZ_OFFSET_MS;
}

async function searchRecords(fromMs) {
  const token = await tenantToken();
  const body = {
    field_names: Object.values(FIELDS),
    sort: [{ field_name: FIELDS.time, desc: false }],
    automatic_fields: false,
  };
  if (fromMs != null) {
    // 日期筛选是按天比较的；向前多取一天，再在下面按毫秒精确裁掉
    body.filter = {
      conjunction: 'and',
      conditions: [{ field_name: FIELDS.time, operator: 'isGreater', value: ['ExactDate', String(fromMs - DAY_MS)] }],
    };
  }
  const base = `${FEISHU}/bitable/v1/apps/${env('BASE_TOKEN')}/tables/${env('TABLE_ID')}/records/search`;
  const items = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const res = await fetch(`${base}?${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code !== 0) throw new FeishuError('search', data);
    items.push(...(data.data.items || []));
    pageToken = data.data.has_more ? data.data.page_token : '';
  } while (pageToken);
  return items;
}

// 飞书单元格值有多种形态：数字、字符串、[{type,text}] 文本片段数组
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(cellText).join('');
  if (typeof v === 'object') return v.text != null ? String(v.text) : '';
  return '';
}

function normalize(item) {
  const f = item.fields || {};
  return {
    id: item.record_id,
    time: Number(f[FIELDS.time]) || null,
    amount: Number(f[FIELDS.amount]) || 0,
    category: cellText(f[FIELDS.category]),
    note: cellText(f[FIELDS.note]),
    review: cellText(f[FIELDS.review]),
  };
}

// 全角/半角视为相同（手机中文键盘打出的「！」与英文键盘的「!」都能通过）
const normToken = (t) => String(t).normalize('NFKC').trim();

function safeEqual(a, b) {
  const x = Buffer.from(normToken(a));
  const y = Buffer.from(normToken(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const AUTH_FAIL_DELAY_MS = 3000; // 口令错误时延迟响应，拖慢逐个试口令
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function corsHeaders(origin) {
  const allowed = (process.env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function reply(statusCode, obj, cors) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
    isBase64Encoded: false,
    body: JSON.stringify(obj),
  };
}

function parseEvent(event) {
  if (Buffer.isBuffer(event)) return JSON.parse(event.toString('utf8'));
  if (typeof event === 'string') return JSON.parse(event);
  return event || {};
}

exports.safeEqual = safeEqual; // 专属记账地址接口（shortcut.js）也用它核对看板口令

const rawHandler = async (rawEvent) => {
  const event = parseEvent(rawEvent);
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const cors = corsHeaders(headers.origin);
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';

  if (method === 'OPTIONS') return reply(204, {}, cors);
  if (method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' }, cors);

  let req;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
    req = JSON.parse(raw || '{}');
  } catch {
    return reply(400, { ok: false, error: 'bad_json' }, cors);
  }
  if (!req.token || !safeEqual(req.token, env('API_TOKEN'))) {
    await sleep(AUTH_FAIL_DELAY_MS);
    return reply(401, { ok: false, error: 'unauthorized' }, cors);
  }

  const fromMs = req.from ? dayStartMs(req.from) : null;
  if (req.from && fromMs == null) return reply(400, { ok: false, error: 'bad_from', hint: 'YYYY-MM-DD' }, cors);

  try {
    const { getSettings } = require('./settings.js');
    const { canonicalCategory } = require('./category-sync.js');
    const settings = await getSettings(0);
    const items = await searchRecords(fromMs);
    const records = items.map(normalize).map((r) => ({ ...r, category: canonicalCategory(r.category, settings.names, settings.aliases) })).filter((r) => r.time != null && (fromMs == null || r.time >= fromMs));
    return reply(200, { ok: true, from: req.from || null, count: records.length, records, syncedAt: Date.now() }, cors);
  } catch (err) {
    console.error(err);
    const quota = err.feishuCode === 99991403;
    return reply(502, { ok: false, error: quota ? 'feishu_quota_exceeded' : 'feishu_error', detail: err.message }, cors);
  }
};

// 双轨入口：线上版先解析租户、注入上下文（读接口不校验会员，过期也能看自己的账）
exports.handler = withTenant(rawHandler, { write: false });
