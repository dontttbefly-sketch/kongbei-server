'use strict';
// 空杯记账 · 改一笔：看板里点开一笔账，改金额、备注、分类、日期 → 写回飞书多维表格（更新这一条记录）；也能删一笔
//
// POST /api/edit   Content-Type: text/plain（和 /api/records 一样是简单请求，不触发预检）
//   body: {"token": 看板口令, "id": "rec…", "amount": -28.5, "category": "🍲一日三餐", "note": "午饭", "time": 毫秒, "dryRun": 可选}
//   amount / category / note / time 至少带一个，只改带了的字段（复盘等其它列不动）
//   resp: {"ok": true, "record": {"id", "amount"?, "category"?, "note"?, "time"?}, "attempts", "ms"}
//   删一笔（2026-10-07）：{"token", "id", "delete": true} → {"ok": true, "deleted": true, "id"}。飞书里已经没有这一笔也算删成了（重试不会报错）
// 金额的正负由看板按表里的约定定好（支出负、收入正、退款正）；分类是「💳收入」时这里兜底翻成正数，和记账接口一致。
// note 传空字符串 = 清空备注。一次修改 = 一次飞书调用（取 token 的接口不计额度）

const { CATEGORY_OPTIONS, normalizeCategory } = require('./accounting.js');
const { safeEqual } = require('./index.js');
const { configOf, cacheKey } = require('./tenant.js');
const { withTenant } = require('./saas.js');

const FEISHU = 'https://open.feishu.cn/open-apis';
const FIELDS = { amount: '金额', category: '账单类目', note: '备注', time: '记账日期' };
const MIN_TIME = Date.UTC(2000, 0, 1);
const DAY_MS = 24 * 3600 * 1000;
const INCOME = '💳收入';
const DEADLINE_MS = 12_000; // 函数最长 15 秒，留点余量
const AUTH_FAIL_DELAY_MS = 3000; // 和读接口一样：口令错误时延迟响应
const NOT_FOUND = 1254043; // 记录不存在（在飞书里被删了）
const TOKEN_CODES = new Set([99991661, 99991663, 99991668]);
const RETRY_CODES = new Set([99991400, 1254290, 1254291, 1255040, 1255001, 1255002]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
class Retryable extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (k) => {
  const v = configOf(k);
  if (!v) throw new HttpError(500, 'missing_env', `缺少环境变量：${k}`);
  return v;
};

// ── 校验：只收带了的字段 ─────────────────────────────
function checkId(id) {
  if (typeof id !== 'string' || !/^rec[A-Za-z0-9]{4,40}$/.test(id)) throw new HttpError(400, 'invalid_id', 'id 不是飞书记录 id');
}

function buildPatch(req) {
  checkId(req.id);
  const out = {};
  if (req.category !== undefined) {
    // 改的时候不能清空分类（记账接口里空分类会记成「其他」，这里不替用户做这个决定）
    if (req.category == null || String(req.category).trim() === '') throw new HttpError(400, 'invalid_category', `分类不能为空：${CATEGORY_OPTIONS.join('、')}`);
    out.category = normalizeCategory(req.category); // 不带 emoji 的名字也认；不在列表里会抛 400
  }
  if (req.amount !== undefined) {
    const n = typeof req.amount === 'number' ? req.amount : Number(String(req.amount).trim());
    if (typeof req.amount === 'boolean' || !Number.isFinite(n) || n === 0 || Math.abs(n) > 1e8) throw new HttpError(400, 'invalid_amount', '金额要是不为 0 的数字');
    out.amount = Math.round(n * 100) / 100;
    if (out.category === INCOME) out.amount = Math.abs(out.amount);
  }
  if (req.note !== undefined) {
    if (req.note !== null && typeof req.note !== 'string') throw new HttpError(400, 'invalid_note', '备注要是文字');
    out.note = String(req.note ?? '').trim().slice(0, 1000);
  }
  if (req.time !== undefined) {
    // 改日期（2026-10-07）：看板发的是新那一天、时分不变的毫秒数。不收太早的，也不收明天以后的（留一天给时区）
    const t = typeof req.time === 'number' ? req.time : NaN;
    if (!Number.isFinite(t) || t < MIN_TIME || t > Date.now() + DAY_MS) throw new HttpError(400, 'invalid_time', '日期不对：不能早于 2000 年，也不能是明天以后');
    out.time = Math.round(t);
  }
  if (!Object.keys(out).length) throw new HttpError(400, 'nothing_to_update', 'amount / category / note / time 至少带一个');
  return out;
}

function fieldsOf(patch, names = {}) {
  const f = {};
  if (patch.amount !== undefined) f[FIELDS.amount] = patch.amount;
  if (patch.category !== undefined) f[FIELDS.category] = require('./category-sync.js').storedCategory(patch.category, names);
  if (patch.note !== undefined) f[FIELDS.note] = patch.note === '' ? null : patch.note; // null = 清空单元格
  if (patch.time !== undefined) f[FIELDS.time] = patch.time;
  return f;
}

// ── 飞书 ────────────────────────────────────────────
// token 按 cacheKey 隔离（同一实例可能服务多个租户）
const tokenCaches = new Map();
function tokenSlot() {
  const k = cacheKey();
  let slot = tokenCaches.get(k);
  if (!slot) tokenCaches.set(k, (slot = { value: '', expiresAt: 0 }));
  return slot;
}

async function feishu(path, init, deadline) {
  const left = deadline - Date.now();
  if (left < 500) throw new HttpError(504, 'deadline', '写飞书超时');
  let res;
  try {
    res = await fetch(`${FEISHU}${path}`, { ...init, signal: AbortSignal.timeout(Math.min(6000, left)) });
  } catch (e) {
    throw new Retryable(`连不上飞书：${e.name === 'TimeoutError' ? '超时' : e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status >= 500 || res.status === 429 || RETRY_CODES.has(data.code)) throw new Retryable(`飞书暂时出错：HTTP ${res.status} code=${data.code} ${data.msg || ''}`);
  return { status: res.status, data };
}

async function tenantToken(deadline, fresh) {
  const slot = tokenSlot();
  if (!fresh && slot.value && Date.now() < slot.expiresAt) return slot.value;
  const { data } = await feishu('/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env('FEISHU_APP_ID'), app_secret: env('FEISHU_APP_SECRET') }),
  }, deadline);
  if (data.code !== 0 || !data.tenant_access_token) throw new HttpError(502, 'feishu_token_error', data.msg || '获取 tenant_access_token 失败');
  slot.value = data.tenant_access_token;
  slot.expiresAt = Date.now() + (data.expire - 300) * 1000;
  return slot.value;
}

async function updateRecord(id, fields, token, deadline) {
  const { status, data } = await feishu(`/bitable/v1/apps/${env('BASE_TOKEN')}/tables/${env('TABLE_ID')}/records/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  }, deadline);
  if (TOKEN_CODES.has(data.code)) throw Object.assign(new Retryable('token 失效'), { refreshToken: true });
  if (data.code === NOT_FOUND) throw new HttpError(404, 'record_not_found', '这笔在飞书里找不到了（可能已经删掉）');
  if (data.code === 99991403) throw new HttpError(502, 'feishu_quota_exceeded', '飞书本月接口额度已用完');
  if (status >= 300 || data.code !== 0) throw new HttpError(502, 'feishu_update_error', data.msg || `修改失败：HTTP ${status}`);
}

// 删一笔：飞书里已经没有了（之前删过、重试）当成删成了
async function deleteRecord(id, token, deadline) {
  const { status, data } = await feishu(`/bitable/v1/apps/${env('BASE_TOKEN')}/tables/${env('TABLE_ID')}/records/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }, deadline);
  if (TOKEN_CODES.has(data.code)) throw Object.assign(new Retryable('token 失效'), { refreshToken: true });
  if (data.code === NOT_FOUND) return { already: true };
  if (data.code === 99991403) throw new HttpError(502, 'feishu_quota_exceeded', '飞书本月接口额度已用完');
  if (status >= 300 || data.code !== 0) throw new HttpError(502, 'feishu_delete_error', data.msg || `删除失败：HTTP ${status}`);
  return { already: false };
}

// 改、删同一条记录都是幂等的，可以放心重试：最多 3 次，间隔 0.4s、1.2s
async function withRetry(fn, deadline) {
  let fresh = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(fresh), attempts: attempt };
    } catch (e) {
      if (!(e instanceof Retryable) || attempt >= 3 || Date.now() + 1500 > deadline) {
        if (e instanceof Retryable) throw new HttpError(502, 'feishu_unavailable', e.message);
        throw e;
      }
      fresh = !!e.refreshToken;
      await sleep(attempt === 1 ? 400 : 1200);
    }
  }
}

// ── 入口（api/edit.js 转接） ─────────────────────────
function reply(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

async function handle(event) {
  const t0 = Date.now();
  const deadline = t0 + DEADLINE_MS;
  try {
    if (event.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '只接受 POST');
    let req;
    try {
      req = JSON.parse(event.body || '');
    } catch {
      throw new HttpError(400, 'bad_json', 'JSON 格式不正确');
    }
    if (!req || typeof req !== 'object' || Array.isArray(req)) throw new HttpError(400, 'bad_json', 'JSON 顶层必须是对象');
    if (!req.token || !safeEqual(req.token, env('API_TOKEN'))) {
      await sleep(AUTH_FAIL_DELAY_MS);
      throw new HttpError(401, 'unauthorized', '口令不对');
    }
    if (req.delete === true) {
      checkId(req.id);
      if (req.dryRun === true) return reply(200, { ok: true, dryRun: true, deleted: false, id: req.id, ms: Date.now() - t0 });
      const { value, attempts } = await withRetry(async (fresh) => deleteRecord(req.id, await tenantToken(deadline, fresh), deadline), deadline);
      return reply(200, { ok: true, deleted: true, id: req.id, already: value.already, attempts, ms: Date.now() - t0 });
    }
    const patch = buildPatch(req);
    let names = {};
    if (patch.category !== undefined) {
      try { names = (await require('./settings.js').getSettings(0)).names; }
      catch { throw new HttpError(502, 'settings_unavailable', '暂时读不到分类设置，请稍后重试'); }
    }
    if (req.dryRun === true) {
      const { attempts } = await withRetry((fresh) => tenantToken(deadline, fresh), deadline);
      return reply(200, { ok: true, dryRun: true, record: { id: req.id, ...patch }, fields: fieldsOf(patch, names), attempts, ms: Date.now() - t0 });
    }
    const { attempts } = await withRetry(async (fresh) => updateRecord(req.id, fieldsOf(patch, names), await tenantToken(deadline, fresh), deadline), deadline);
    return reply(200, { ok: true, record: { id: req.id, ...patch }, attempts, ms: Date.now() - t0 });
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { ok: false, error: e.code, message: e.message, ms: Date.now() - t0 });
    // normalizeCategory 抛的是记账接口自己的 HttpError（不同的类），按它带的状态码回
    if (e && e.status && e.code) return reply(e.status, { ok: false, error: e.code, message: e.message, ms: Date.now() - t0 });
    console.error(e);
    return reply(500, { ok: false, error: 'internal_error', message: '服务内部错误', ms: Date.now() - t0 });
  }
}

// 双轨入口：线上版先解析租户、注入上下文；改账是写操作，会员过期时返回 402
module.exports = { handle: withTenant(handle, { write: true }), buildPatch, fieldsOf };
