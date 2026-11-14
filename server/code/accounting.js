'use strict';
// 空杯记账 · 记账接口：快捷指令发来一笔 → 写进飞书多维表格「记账数据库」
//
// 请求格式和原来的阿里云 feishu-accounting（以及更早的 Cloudflare feishu-accounting-worker）完全一样，快捷指令只换网址：
//   POST /api/accounting   Content-Type: application/json
//   body: {"amount": 28.5, "class": "一日三餐", "event": "午饭", "date": 可选（毫秒或 ISO，缺省 = 现在）}
//   口令：Authorization: Bearer … / X-Accounting-Secret 头 / body.secret / 网址里的 ?key=，四选一
//   （?key= 是给分享出去的快捷指令用的：看板复制出「专属记账地址」，添加快捷指令时粘贴进唯一一个导入问题）
// 比原来多的：
//   - 写飞书失败（网络、限流、飞书 5xx）自动重试，token 失效自动重取
//   - 带 "id"（或 Idempotency-Key 头）时，同一笔重复发不会记两次：转成飞书新增记录的 client_token。
//     重发时 body 要一模一样（所以快捷指令要自己带 date；缺省用「现在」的话两次内容不同，飞书会拒）
//   - "dryRun": true 只校验、取一次飞书 token，不写表（测速、测稳定性用）
//   - 返回 ms（服务端耗时）、attempts（写飞书用了几次）

const crypto = require('crypto');
const { configOf, cacheKey } = require('./tenant.js');
const { withTenant } = require('./saas.js');

const FEISHU = 'https://open.feishu.cn/open-apis';
const DEFAULT_CATEGORY = '🏷️人情';
const CATEGORY_OPTIONS = ['🍲一日三餐', '🛍️生活日常', '✨值得体验', '👌投资蜕变', '💰投资蜕变·大额', '🚪外出', '🏠住房', '🏷️人情', '💳收入'];
const stripEmoji = (s) => String(s).replace(/^[^\p{Script=Han}A-Za-z0-9]+/u, '').trim();
// 改过名的类目（2026-10-07 用户：开心购物 → 值得体验，其他 → 人情）：旧名字照样认、存成新名字，老快捷指令的菜单不改也能记
const RENAMED_CATEGORIES = { '✨开心购物': '✨值得体验', '🏷️其他': '🏷️人情' };
const CATEGORY_ALIASES = new Map([
  ...CATEGORY_OPTIONS.flatMap((o) => [[o, o], [stripEmoji(o), o]]),
  ...Object.entries(RENAMED_CATEGORIES).flatMap(([old, now]) => [[old, now], [stripEmoji(old), now]]),
]);
const FIELDS = { amount: '金额', date: '记账日期', category: '账单类目', note: '备注' };

// ── 分类菜单：旧快捷指令可记账前 GET，新版从记账成功响应更新下一次的菜单 ──
//   GET /api/accounting?key=…&menu=1  →  {"ok": true, "menu": ["🍲 一日三餐", "🎮 娱乐", …]}
// 顺序和第一版快捷指令的菜单一样（用惯了的位置不变）；记账时发回来的就是菜单上那几个字，这里再认回类目
const MENU_ORDER = ['🍲一日三餐', '🛍️生活日常', '✨值得体验', '👌投资蜕变', '🚪外出', '🏠住房', '🏷️人情', '💰投资蜕变·大额', '💳收入'];
const MENU_MAX_AGE_MS = 0; // 每次取菜单都读最新名字，避免刚改名后显示旧菜单
const EMOJI_HEAD = /^(\p{Extended_Pictographic}\uFE0F?)?\s*([\s\S]*)$/u;
const splitLabel = (s) => {
  const [, emoji = '', name] = EMOJI_HEAD.exec(String(s).trim());
  return [emoji, name.trim()];
};
// 一类在菜单上叫什么：改过名用改的（没带 emoji 的沿用原来的），没改过就是原名；emoji 和名字之间空一格，菜单上好认
function labelOf(category, names = {}) {
  const [emoji, name] = splitLabel(category);
  if (!names[category]) return `${emoji} ${name}`.trim();
  const [e2, n2] = splitLabel(names[category]);
  return `${e2 || emoji} ${n2}`.trim();
}
const squash = (s) => String(s).replace(/\s+/g, '');

const DEADLINE_MS = 12_000; // 函数最长 15 秒，留点余量
const AUTH_FAIL_DELAY_MS = 1500;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 双轨：线上版从租户上下文取（tenant.js 注入），开源版回退 process.env
const env = (k) => {
  const v = configOf(k);
  if (!v) throw new HttpError(500, 'missing_env', `缺少环境变量：${k}`);
  return v;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 后台任务：Vercel 的 Serverless 在响应结束后会冻结实例，没跑完的 promise 就停在半路
//（2026-11-12 实测：改成不 await 之后 QStash 一条都没收到）。
// Vercel 把 waitUntil 挂在 request context 上（@vercel/functions 内部读的就是这个 symbol），
// 零依赖地取出来用它，就能把这些活儿挂到这次调用的生命周期上，响应立刻返回、活儿继续跑完。
const REQ_CTX = Symbol.for('@vercel/request-context');
let bgMode = 'none'; // 自检用：这次后台任务是怎么挂上去的（waitUntil / none）
const keepAlive = (p) => {
  p.catch((e) => console.error('后台任务失败', e && e.message)); // 后台出错只能记日志，不能影响已经返回的响应
  try {
    const ctx = globalThis[REQ_CTX]?.get?.();
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(p);
      bgMode = 'waitUntil';
      return;
    }
  } catch {
    /* 取不到就退到下面 */
  }
  // 本地 / 别的运行时：event loop 会撑着，不做额外处理
  bgMode = 'none';
};

// ── 校验和整理（和原来的函数一致） ─────────────────────────
function normalizeAmount(v) {
  if (typeof v === 'boolean' || v == null) throw new HttpError(400, 'invalid_amount', 'amount 必须是数字');
  // 空字符串会 Number('') = 0，被当成合法的 0 写进表（2026-11-09：快捷指令没取到金额时记了 29 笔 0）。
  // 0 也没有记账意义，一起拒掉：宁可让快捷指令报错，也不要静默写一笔 0。
  const text = typeof v === 'number' ? '' : String(v).trim();
  if (typeof v !== 'number' && text === '') throw new HttpError(400, 'invalid_amount', 'amount 不能为空（没有取到金额）');
  const n = typeof v === 'number' ? v : Number(text);
  if (!Number.isFinite(n)) throw new HttpError(400, 'invalid_amount', 'amount 必须是数字');
  if (n === 0) throw new HttpError(400, 'invalid_amount', 'amount 不能是 0');
  return n;
}
// names：看板里改过的名字（看板设置的 names）。先按改过的名字认（带不带 emoji、有没有空格都行），再按原名、旧名认
function normalizeCategory(v, names = {}) {
  if (v == null || String(v).trim() === '') return DEFAULT_CATEGORY;
  const t = String(v).trim();
  const key = squash(t);
  for (const c of Object.keys(names)) {
    const label = labelOf(c, names);
    if (squash(label) === key || squash(splitLabel(label)[1]) === squash(stripEmoji(t))) return c;
  }
  const c = CATEGORY_ALIASES.get(t) || CATEGORY_ALIASES.get(stripEmoji(t)) || CATEGORY_ALIASES.get(key) || CATEGORY_ALIASES.get(squash(stripEmoji(t)));
  if (!c) throw new HttpError(400, 'invalid_category', `账单类目不在允许列表中：${MENU_ORDER.map((x) => labelOf(x, names)).join('、')}`);
  return c;
}
const normalizeNote = (v) => (v == null ? '' : String(v).trim().slice(0, 1000));
function normalizeDate(v, now = Date.now()) {
  if (v == null || v === '') return now;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v).trim());
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid_date', 'date 必须是可解析的日期');
  return d.getTime();
}

// 表里的约定：支出记负数、收入记正数（看板按这个统计）。快捷指令一律发负数，所以「💳收入」在这里翻成正数；
// 其它类目原样存（其它类目里的正数是退款，按冲减支出算，不能动）
const INCOME = '💳收入';

function buildRecord(body, names = {}) {
  const category = normalizeCategory(body.class ?? body.category ?? body['账单类目'], names);
  const amount = normalizeAmount(body.amount ?? body['金额']);
  return {
    fields: {
      [FIELDS.amount]: category === INCOME ? Math.abs(amount) : amount,
      [FIELDS.date]: normalizeDate(body.date ?? body['记账日期']),
      [FIELDS.category]: category,
      [FIELDS.note]: normalizeNote(body.event ?? body.note ?? body['备注']),
    },
  };
}

// 防重复：飞书的 client_token 要 UUIDv4 格式。快捷指令没有生成 UUID 的动作，所以接受任意字符串，
// 本身是 UUID 就直接用，否则用 SHA-256 摘要拼成 UUIDv4 的样子（同一个 id 永远得到同一个 token）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function clientToken(id) {
  if (id == null || String(id).trim() === '') return null;
  const s = String(id).trim();
  if (UUID_RE.test(s)) return s.toLowerCase();
  const h = crypto.createHash('sha256').update(`kongbei:${s}`).digest('hex');
  const v = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function authorized(headers, body, query, expected) {
  const auth = headers.authorization || '';
  const candidates = [auth.startsWith('Bearer ') ? auth.slice(7).trim() : '', headers['x-accounting-secret'] || '', body.secret ? String(body.secret) : '', query.key ? String(query.key) : ''];
  const want = Buffer.from(expected);
  return candidates.some((c) => {
    if (!c) return false;
    const got = Buffer.from(c);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}

// ── 飞书 ────────────────────────────────────────────
// 实例存活期间复用 token，但按 cacheKey 隔离：同一个实例可能服务多个租户，绝不能串
const tokenCaches = new Map();
function tokenSlot() {
  const k = cacheKey();
  let slot = tokenCaches.get(k);
  if (!slot) tokenCaches.set(k, (slot = { value: '', expiresAt: 0 }));
  return slot;
}

// 网络错误、HTTP 5xx / 429、飞书限流或内部错误 → 可以重试
const RETRY_CODES = new Set([99991400, 1254290, 1254291, 1255040, 1255001, 1255002]);
const TOKEN_CODES = new Set([99991661, 99991663, 99991668]);
const DUPLICATE = 1254608; // 同一个 client_token 已经写过（「Same API requests are submitted repeatedly.」）= 这笔早就记上了
class Retryable extends Error {}

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

async function tenantToken(deadline, fresh = false) {
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

async function createRecord(record, token, ct, deadline) {
  const qs = ct ? `?client_token=${encodeURIComponent(ct)}` : '';
  const { status, data } = await feishu(`/bitable/v1/apps/${env('BASE_TOKEN')}/tables/${env('TABLE_ID')}/records${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(record),
  }, deadline);
  if (TOKEN_CODES.has(data.code)) throw Object.assign(new Retryable('token 失效'), { refreshToken: true });
  // 重发的同一笔（上次其实写成功了、只是回执没送到手机）：当成功，别让快捷指令以为失败又去走备用线路
  if (ct && data.code === DUPLICATE) return { recordId: null, duplicate: true };
  if (status >= 300 || data.code !== 0) throw new HttpError(502, 'feishu_create_record_error', data.msg || `创建记录失败：HTTP ${status}`);
  return { recordId: data.data?.record?.record_id ?? null, duplicate: false };
}

// 最多 3 次，间隔 0.4s、1.2s；不可重试的错误（参数、权限）直接抛出
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

// 获取菜单时读不到设置就明确失败，不能把原名冒充最新分类。
async function namesNow(maxAgeMs) {
  const { getSettings } = require('./settings.js'); // 晚一点取：settings.js 也 require 本文件，顶层取会成环
  try {
    return (await getSettings(maxAgeMs))?.names ?? {};
  } catch (e) {
    console.error(e);
    throw new HttpError(502, 'settings_unavailable', '暂时读不到分类设置，请稍后重试');
  }
}

// ── 入口：和 records 一样吃阿里云 HTTP 触发器那套事件格式（api/accounting.js 转接） ──
function reply(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, isBase64Encoded: false, body: JSON.stringify(obj) };
}

async function handle(event) {
  const t0 = Date.now();
  const deadline = t0 + DEADLINE_MS;
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const method = event.requestContext?.http?.method || 'GET';
  try {
    const query = event.queryParameters || {};
    if (method === 'GET' && query.menu) {
      // 取分类菜单：要记账口令（和记账一样）。
      if (!authorized(headers, {}, query, env('ACCOUNTING_SECRET'))) {
        await sleep(AUTH_FAIL_DELAY_MS);
        throw new HttpError(401, 'unauthorized', '调用密码不正确');
      }
      const names = await namesNow(MENU_MAX_AGE_MS);
      return reply(200, { ok: true, menu: MENU_ORDER.map((c) => labelOf(c, names)) });
    }
    if (method === 'GET') return reply(200, { ok: true, service: 'kongbei-accounting' }); // 健康检查，不碰飞书
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '只接受 POST');
    if (!(headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'unsupported_media_type', '请求体必须是 JSON');
    let body;
    try {
      body = JSON.parse(event.body || '');
    } catch {
      throw new HttpError(400, 'invalid_json', 'JSON 格式不正确');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_json', 'JSON 顶层必须是对象');
    if (!authorized(headers, body, event.queryParameters || {}, env('ACCOUNTING_SECRET'))) {
      await sleep(AUTH_FAIL_DELAY_MS);
      throw new HttpError(401, 'unauthorized', '调用密码不正确');
    }
    // 先验证金额和日期，输入有误时不请求飞书设置。
    normalizeAmount(body.amount ?? body['金额']);
    normalizeDate(body.date ?? body['记账日期']);
    // 写入飞书使用最新显示名；内部仍以稳定分类标识处理收入、提醒和旧快捷指令。
    // 缓存 1 分钟：读一次「看板设置」在线上实测要 2.4 秒，每笔都现读太贵；
    // 代价是刚在看板改了分类名，最多 1 分钟后才在新账上生效（可接受，改名不是高频动作）
    let settings;
    try {
      settings = await require('./settings.js').getSettings(60_000);
    } catch {
      throw new HttpError(502, 'settings_unavailable', '暂时读不到分类设置，请稍后重试');
    }
    const { canonicalCategory, storedCategory } = require('./category-sync.js');
    const inputCategory = body.class ?? body.category ?? body['账单类目'];
    const canonical = inputCategory == null ? inputCategory : canonicalCategory(inputCategory, settings.names, settings.aliases);
    const record = buildRecord({ ...body, class: canonical }, settings.names);
    const category = record.fields[FIELDS.category];
    record.fields[FIELDS.category] = storedCategory(category, settings.names);
    const ct = clientToken(body.id ?? headers['idempotency-key']);

    // 下一次记账要用的分类随本次结果返回，无需在选分类前再等一次网络。
    const menu = MENU_ORDER.map((c) => labelOf(c, settings?.names ?? {}));
    if (body.dryRun === true) {
      const { attempts } = await withRetry((fresh) => tenantToken(deadline, fresh), deadline);
      return reply(200, { ok: true, shortcut_status: 'saved', dryRun: true, fields: record.fields, menu, attempts, ms: Date.now() - t0 });
    }
    const { value, attempts } = await withRetry(async (fresh) => createRecord(record, await tenantToken(deadline, fresh), ct, deadline), deadline);
    // 备注提醒（2026-10-07）：没写备注的支出，顺手向 QStash 预约提醒。
    // 2026-11-12：改成**完全后台**——原来用 Promise.race 等最多 2.5 秒，占着这次请求的时间；
    // 现在直接不管它，记账接口立刻返回（实测每笔省 0.3~2.5 秒）。
    // 后台失败只是没有提醒，账已经写进去了，所以这里故意不 await、不抛错；
    // 外层 keepAlive 保证 Serverless 冻结前这个 promise 还能跑完。
    let reminders = 0;
    if (!value.duplicate && value.recordId) {
      const { scheduleReminders } = require('./remind.js');
      const f = record.fields;
      // 数量未知（还没跑完）就回 null，别拿 0 冒充「一条都没约上」
      reminders = null;
      keepAlive(
        scheduleReminders({ id: value.recordId, note: f[FIELDS.note], category, amount: f[FIELDS.amount] }, headers['x-forwarded-host'] || headers.host).catch((e) => {
          console.error('预约提醒失败', e && e.message);
          return 0;
        }),
      );
    }
    return reply(200, { ok: true, shortcut_status: 'saved', record_id: value.recordId, duplicate: value.duplicate, fields: record.fields, menu, attempts, reminders, bg: bgMode, ms: Date.now() - t0 });
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { ok: false, shortcut_status: 'failed', error: e.code, message: e.message, ms: Date.now() - t0 });
    console.error(e);
    return reply(500, { ok: false, shortcut_status: 'failed', error: 'internal_error', message: '服务内部错误', ms: Date.now() - t0 });
  }
}

// 双轨入口：线上版先解析租户、注入上下文；记账是写操作，会员过期时返回 402
module.exports = { handle: withTenant(handle, { write: true, tenantOnGet: true }), buildRecord, clientToken, normalizeCategory, normalizeDate, labelOf, CATEGORY_OPTIONS, RENAMED_CATEGORIES, MENU_ORDER };
