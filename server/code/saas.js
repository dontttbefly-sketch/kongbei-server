'use strict';
// 空杯记账 · 线上版（SaaS）业务：绑定飞书账本 / 会员状态 / 激活码 / 换口令 / 运营管理
// 以及把既有接口「双轨化」的请求包装器 withTenant（开源版原样透传，线上版注入租户上下文）
//
// 对外接口：都在 POST /api/saas（api/saas.js），body.action 区分：
//   {action:'status'} | {action:'status', token}   → {saas:true}（探测）/ 会员状态
//   {action:'bind', appId, appSecret}              → 验证凭证、找/建账本表、发专属口令（手动连接）
//   {action:'create-begin'} / {action:'create-poll', sessionId} → 一键创建飞书应用
//   {action:'activate', token, code}               → 用激活码开通/续期
//   {action:'rotate', token}                       → 换一对新口令（账本、会员不动）
//   {action:'gencode'|'codes'|'list'|'show'|'reset'|'grant', ...} + X-Admin-Token 头 → 运营管理
//
// 隐私（不存账单、凭证加密、代码公开、用户随时能吊销）：
//   - 本文件不接触、不存储任何账单数据；只处理租户元数据与凭证
//   - 凭证仅加密落库、按需解密于单次请求内存，不打印、不外传
//   - 运营管理只能「重置」口令，不能「查看」口令：运营方没法不声不响地进别人的账本

const crypto = require('node:crypto');

const {
  isSaas,
  storage,
  resolveTenant,
  runWithTenant,
  currentTenant,
  memberActive,
  freeMode,
  encryptText,
  newUserId,
  newToken,
  saveTenant,
  findTenantByApp,
  loadTenant,
  clearResolveCache,
  contextFromRecord,
  codeKey,
  CODES_SET,
  newCode,
  normalizeCode,
  safeEqualText,
} = require('./tenant.js');

const FEISHU = 'https://open.feishu.cn/open-apis';
const LEDGER_NAME = '记账数据库'; // 和开源版使用说明里的表名一致，重复绑定能认出来
const AUTH_FAIL_DELAY_MS = 3000;
const DAY_MS = 24 * 3600 * 1000;
// 新用户绑定即送试用天数（0 = 不送，绑定后必须激活才能记账）。可用 SAAS_TRIAL_DAYS 改；没配或留空 = 7 天。
// 2026-10-19 起线上版开着免费模式（SAAS_FREE=1，见 tenant.js 的 freeMode），试用天数先不起作用
function trialDays() {
  const raw = String(process.env.SAAS_TRIAL_DAYS ?? '').trim();
  return raw === '' ? 7 : Math.max(Number(raw) || 0, 0);
}

// 账本表需要的字段（与看板读取的字段名严格一致：金额 / 账单类目 / 记账日期 / 备注 / 复盘）
// 飞书字段类型：1=文本 2=数字 3=单选 5=日期
// 账单类目的选项必须和 accounting.js 的 CATEGORY_OPTIONS 完全一致，否则记账写入会被飞书拒绝
const FIELDS_SPEC = [
  { name: '备注', type: 1 },
  { name: '金额', type: 2 },
  { name: '记账日期', type: 5 },
  { name: '账单类目', type: 3, withCategories: true },
  { name: '复盘', type: 1 },
];

// 账单类目字段的完整定义（延迟取 CATEGORY_OPTIONS：accounting.js 也 require 本文件，顶层取会成环）
function categoryFieldSpec() {
  const { CATEGORY_OPTIONS } = require('./accounting.js');
  return { field_name: '账单类目', type: 3, property: { options: CATEGORY_OPTIONS.map((name) => ({ name })) } };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reply(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

// 会员过期时写接口的回复（402）；推送接口里「开提醒」「试推」也用它
const EXPIRED_BODY = { ok: false, error: 'membership_expired', message: '会员已到期。你的账都还在你自己的飞书里，续费后马上能继续记。' };

// 这次请求是不是一个会员已过期的租户（开源版、运营方自用都算没过期）
function membershipExpired() {
  if (!isSaas()) return false;
  const ctx = currentTenant();
  return !!ctx && !memberActive(ctx.tenant);
}

// ── 请求包装器：让既有接口一行不改地支持线上版 ─────────────
// 开源版（未配 SAAS_MODE）：原样调用 handler，行为和改造前 100% 一致
// 线上版：从请求里取口令 → 解析租户 → 注入上下文（之后所有 env('BASE_TOKEN') 自动拿租户的值）
//   · 运营方自用兼容：口令等于环境变量里那两串时，按「自带账本」模式走（上下文为空 → configOf 自动回退 process.env）。
//     现在线上版和自用版是两个 Vercel 项目，线上版项目不配这两个变量，这条路走不到；留着不碍事
//   · write=true 的接口在会员过期时返回 402；读接口放行（数据是用户的，到期也能看自己的账）
// tenantOnGet：GET 带了口令也要认出是谁（记账接口的「取分类菜单」，2026-10-18）；GET 不带口令照旧是健康检查、不鉴权
function withTenant(handler, { write = false, tenantOnGet = false } = {}) {
  return async (event) => {
    if (!isSaas()) return handler(event);

    const headers = {};
    for (const [k, v] of Object.entries(event?.headers || {})) headers[k.toLowerCase()] = String(v);
    const method = String(event?.method || event?.requestContext?.http?.method || 'POST').toUpperCase();
    if (method === 'OPTIONS') return handler(event); // 预检不鉴权
    if (method === 'GET' && (!tenantOnGet || !extractToken(event, headers))) return handler(event); // 健康检查不鉴权

    const token = extractToken(event, headers);
    if (!token) {
      await sleep(AUTH_FAIL_DELAY_MS);
      return reply(401, { ok: false, error: 'unauthorized', message: '缺少口令' });
    }

    // 运营方自用：口令与环境变量里的完全一致（精确匹配，不是「任意口令放行」），走 .env 模式
    const selfView = process.env.API_TOKEN;
    const selfAccount = process.env.ACCOUNTING_SECRET;
    if ((selfView && safeEqualText(token, selfView)) || (selfAccount && safeEqualText(token, selfAccount))) {
      return handler(event);
    }

    let ctx = null;
    try {
      ctx = await resolveTenant(token);
    } catch (e) {
      console.error(e);
      return reply(500, { ok: false, error: 'store_error', message: '服务暂时不可用，稍后再试' });
    }
    if (!ctx) {
      await sleep(AUTH_FAIL_DELAY_MS);
      return reply(401, { ok: false, error: 'unauthorized', message: '口令不对' });
    }
    if (write && method !== 'GET' && !memberActive(ctx.tenant)) return reply(402, EXPIRED_BODY); // 读（GET）不拦，到期了照样能看菜单
    return runWithTenant(ctx, () => handler(event));
  };
}

// 从各种请求形态里取口令：Authorization 头 / X-Accounting-Secret 头 / body.token / body.secret / ?key=
function extractToken(event, headers) {
  const auth = headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (headers['x-accounting-secret']) return String(headers['x-accounting-secret']).trim();

  let body = event?.body;
  if (event?.isBase64Encoded && typeof body === 'string') {
    try {
      body = Buffer.from(body, 'base64').toString('utf8');
    } catch {}
  }
  try {
    const b = JSON.parse(body || '');
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      if (typeof b.token === 'string' && b.token.trim()) return b.token.trim();
      if (typeof b.secret === 'string' && b.secret.trim()) return b.secret.trim();
    }
  } catch {}

  const q = event?.queryParameters || event?.query || {};
  if (q && q.key) return String(q.key).trim();
  return '';
}

// ── 限流：不用口令就能调、又要去飞书跑一圈的动作（手动绑定、一键创建）按 IP 计数 ──
// 防有人刷：每刷一次都要写租户库、调飞书，刷多了会把 Upstash 的免费额度用光，所有人一起停
const RATE_LIMITS = {
  bind: { max: 10, windowSec: 600 },
  'create-begin': { max: 10, windowSec: 600 },
  passkey: { max: 30, windowSec: 600 }, // 面容 ID 登录（passkey.js）：正常人十分钟按不了 30 次
};

function clientIp(headers = {}) {
  return String(headers['x-real-ip'] || headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
}

async function rateLimit(kind, headers) {
  const rule = RATE_LIMITS[kind];
  const ip = clientIp(headers);
  if (!rule || !ip) return; // 拿不到 IP（本地、测试）就不限
  const key = `rl:${kind}:${ip}:${Math.floor(Date.now() / (rule.windowSec * 1000))}`;
  const n = await storage().incr(key);
  if (n === 1) await storage().expire(key, rule.windowSec);
  if (n > rule.max) throw new HttpError(429, 'too_many_requests', '试得太频繁了，过十分钟再来');
}

// ── 飞书调用（绑定阶段专用：此时还没有租户上下文，直连） ────
async function fsApi(method, path, { token, body, timeout = 8000 } = {}) {
  const res = await fetch(`${FEISHU}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 0) throw new HttpError(502, 'feishu_error', `飞书接口出错（${data.code}）：${data.msg || `HTTP ${res.status}`}`);
  return data.data || {};
}

async function getAppToken(appId, appSecret) {
  const res = await fetch(`${FEISHU}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new HttpError(400, 'invalid_credentials', `「账本连接码」或「账本安全密钥」不对，回飞书开发者后台再复制一次（飞书说：${data.msg || '校验失败'}）`);
  }
  return data.tenant_access_token;
}

// 找用户云空间里已有的「记账数据库」多维表格（需要 drive 权限；没权限就当作没有，走创建）
async function findLedger(token) {
  try {
    const d = await fsApi('GET', '/drive/v1/files?page_size=200&order_by=EditedTime', { token });
    const hit = (d.files || []).find((f) => f.type === 'bitable' && f.name === LEDGER_NAME);
    return hit ? { token: hit.token, url: hit.url || '' } : null;
  } catch {
    return null;
  }
}

async function createLedger(token) {
  const d = await fsApi('POST', '/bitable/v1/apps', { token, body: { name: LEDGER_NAME } });
  const app = d.app || {};
  if (!app.app_token) throw new HttpError(502, 'create_failed', '创建多维表格失败，确认「多维表格」权限已开通并发布版本');
  return { token: app.app_token, tableId: app.default_table_id, url: app.url || '' };
}

// 首次进入表：拿到 table_id（创建时已有默认表；复用旧表时取第一张表）
async function ledgerTableId(baseToken, knownTableId, token) {
  if (knownTableId) return knownTableId;
  const d = await fsApi('GET', `/bitable/v1/apps/${baseToken}/tables?page_size=100`, { token });
  const first = (d.items || [])[0];
  if (!first) throw new HttpError(502, 'no_table', '这张多维表格里没有数据表');
  return first.table_id;
}

// 保证字段齐全：主字段改名「备注」，缺的字段补上。已有的不重名不动
async function ensureFields(baseToken, tableId, token) {
  const d = await fsApi('GET', `/bitable/v1/apps/${baseToken}/tables/${tableId}/fields?page_size=100`, { token });
  const fields = d.items || [];
  const byName = new Set(fields.map((f) => f.field_name));

  if (!byName.has('备注')) {
    const primary = fields.find((f) => f.is_primary);
    if (primary) {
      await fsApi('PUT', `/bitable/v1/apps/${baseToken}/tables/${tableId}/fields/${primary.field_id}`, { token, body: { field_name: '备注', type: 1 } });
      byName.add('备注');
    }
  }
  for (const f of FIELDS_SPEC) {
    if (byName.has(f.name)) continue;
    const body = f.withCategories ? categoryFieldSpec() : { field_name: f.name, type: f.type };
    await fsApi('POST', `/bitable/v1/apps/${baseToken}/tables/${tableId}/fields`, { token, body });
    byName.add(f.name);
  }
}

// 发一对新口令（看板口令 + 记账口令）写进租户记录，旧的两串随之作废。
// 别的函数实例里还缓存着旧口令的，最多再认 RESOLVE_TTL_MS（60 秒）
function issueTokens(rec) {
  const access = newToken(rec.id);
  const account = newToken(rec.id);
  rec.accessEnc = encryptText(access);
  rec.accountEnc = encryptText(account);
  return { access, account };
}

// ── 绑定 ─────────────────────────────────────────────
// 建表 + 字段 + 发口令：手动绑定（bind）和「一键创建应用」（createAppPoll）共用这一条路
async function finishBinding(appId, appSecret) {
  const token = await getAppToken(appId, appSecret); // 第一步：验证凭证有效

  let ledger = await findLedger(token); // 第二步：找已有账本（重复绑定/换设备不重复建表）
  let tableId = '';
  let created = false;
  if (ledger) {
    tableId = await ledgerTableId(ledger.token, '', token);
  } else {
    const made = await createLedger(token);
    ledger = { token: made.token, url: made.url };
    tableId = made.tableId;
    created = true;
  }
  await ensureFields(ledger.token, tableId, token); // 第三步：字段齐全（幂等）

  // 第四步：发（或重置）专属口令。同一应用重复绑定 = 换口令，旧口令立即失效；会员、激活记录照旧
  const existing = await findTenantByApp(appId);
  const id = existing?.id || newUserId();
  const rec = {
    ...(existing || {}),
    id,
    createdAt: existing?.createdAt || Date.now(),
    boundAt: Date.now(),
    // 重复绑定保留原会员/试用剩余时间；首次绑定送试用期（否则新用户一绑定就是「记不了账」）
    expireAt: existing?.expireAt || (trialDays() > 0 ? Date.now() + trialDays() * DAY_MS : 0),
    appId,
    secretEnc: encryptText(appSecret),
    baseToken: ledger.token,
    tableId,
    tableUrl: ledger.url || `https://feishu.cn/base/${ledger.token}`,
  };
  const { access, account } = issueTokens(rec);
  await saveTenant(rec);
  clearResolveCache(id);

  return {
    userId: id,
    accessToken: access,
    accountingToken: account,
    tableId,
    tableUrl: rec.tableUrl,
    created,
    reused: !!existing,
    expireAt: rec.expireAt,
    trialDays: !existing && !freeMode() ? trialDays() : 0, // 免费模式：不提试用
  };
}

async function bind(req, headers) {
  const appId = String(req?.appId || '').trim();
  const appSecret = String(req?.appSecret || '').trim();
  if (!/^cli_[A-Za-z0-9]{10,40}$/.test(appId)) throw new HttpError(400, 'invalid_app_id', '应用 ID 不对：应以 cli_ 开头，在飞书开发者后台「凭证与基础信息」页复制');
  if (appSecret.length < 20 || appSecret.length > 200) throw new HttpError(400, 'invalid_app_secret', '安全密钥不对：长度不像飞书的 App Secret，确认复制完整');
  await rateLimit('bind', headers);

  return { ok: true, ...(await finishBinding(appId, appSecret)) };
}

// ── 一键创建应用（用户在飞书点一下确认，凭证自动回到这里） ──
// 协议见 feishu-register.js。两步式适配 Serverless：begin 拿链接 + sessionId，poll 拿凭证后直接完成绑定
const REG_KEY = (sid) => `reg:${sid}`;
const REG_TTL_MS = 10 * 60 * 1000;

async function createAppBegin(headers) {
  await rateLimit('create-begin', headers);
  const { begin } = require('./feishu-register.js');
  const out = await begin({ name: '空杯记账', desc: '把你的账记进自己的飞书', scopes: ['bitable:app', 'drive:drive'] });
  const sid = crypto.randomBytes(12).toString('base64url');
  // 会话 10 分钟后自己过期：用户中途走掉也不会在租户库里留垃圾
  await storage().set(REG_KEY(sid), JSON.stringify({ deviceCode: out.deviceCode, createdAt: Date.now() }), REG_TTL_MS / 1000);
  return {
    ok: true,
    sessionId: sid,
    url: out.url,
    intervalMs: Math.max(out.intervalMs, 3000), // 别把飞书问太急
    expiresInMs: out.expiresInMs,
  };
}

async function createAppPoll(req) {
  const sid = String(req?.sessionId || '').trim();
  if (!sid) throw new HttpError(400, 'bad_session', '缺少会话标识');
  const raw = await storage().get(REG_KEY(sid));
  if (!raw) throw new HttpError(410, 'session_expired', '这次连接已经超时了，重新点一次「一键创建」');
  const sess = JSON.parse(raw);
  if (Date.now() - sess.createdAt > REG_TTL_MS) {
    await storage().del(REG_KEY(sid)).catch(() => {});
    throw new HttpError(410, 'session_expired', '这次连接已经超时了，重新点一次「一键创建」');
  }

  const { poll } = require('./feishu-register.js');
  const out = await poll(sess.deviceCode);
  if (out.pending) return { ok: true, pending: true, slowDown: !!out.slowDown };
  if (out.expired) {
    await storage().del(REG_KEY(sid)).catch(() => {});
    throw new HttpError(410, 'session_expired', '链接过期了，重新点一次「一键创建」');
  }
  if (out.denied) {
    await storage().del(REG_KEY(sid)).catch(() => {});
    throw new HttpError(403, 'denied', '你在飞书里取消了。想再试，重新点一次「一键创建」');
  }
  if (out.unknown) throw new HttpError(502, 'feishu_error', `飞书返回了意外的结果：${out.detail}`);

  const result = await finishBinding(out.appId, out.appSecret); // 和手动绑定同一条路
  await storage().del(REG_KEY(sid)).catch(() => {});
  return { ok: true, ...result };
}

// ── 会员状态 ──────────────────────────────────────────
async function status(req) {
  if (!isSaas()) return { ok: true, saas: false }; // 开源版部署：前端据此不显示会员相关界面
  const token = String(req?.token || '').trim();
  if (!token) return { ok: true, saas: true, bound: false }; // 探测模式：只回答「这是线上版部署」

  // 运营方自用：口令等于环境变量里那两串 → 明确答复「自用」，前端不显示会员区块
  const selfView = process.env.API_TOKEN;
  const selfAccount = process.env.ACCOUNTING_SECRET;
  if ((selfView && safeEqualText(token, selfView)) || (selfAccount && safeEqualText(token, selfAccount))) {
    return { ok: true, saas: true, bound: true, self: true, active: true, expireAt: 0, tableUrl: '' };
  }

  const ctx = await resolveTenant(token);
  if (!ctx) throw new HttpError(401, 'unauthorized', '口令不对');
  const rec = ctx.tenant;
  return {
    ok: true,
    saas: true,
    bound: true,
    userId: rec.id,
    active: memberActive(rec),
    free: freeMode(), // 免费模式：看板不显示会员、到期、激活码
    expireAt: rec.expireAt || 0,
    tableUrl: rec.tableUrl || '',
    boundAt: rec.boundAt || rec.createdAt || 0,
  };
}

// ── 换口令 ────────────────────────────────────────────
// 凭现在的看板口令换一对新的（看板口令 + 记账口令），旧的两串作废。账本、会员、试用都不动——
// 口令或专属记账地址发出去了、想换一串时用。用户 ID 不变，所以租户记录里的一切都留着
async function rotate(req) {
  if (!isSaas()) throw new HttpError(400, 'not_saas', '这是开源版部署，口令在 Vercel 的环境变量里改');
  const token = String(req?.token || '').trim();
  const ctx = await resolveTenant(token);
  // 只认看板口令：记账口令跟着快捷指令到处走，拿它不能把整套口令换掉
  if (!ctx || !safeEqualText(token, ctx.config.API_TOKEN)) {
    await sleep(AUTH_FAIL_DELAY_MS);
    throw new HttpError(401, 'unauthorized', '口令不对');
  }
  const rec = await loadTenant(ctx.tenant.id); // 读最新的一份：缓存里的可能是一分钟前的（比如刚激活过）
  if (!rec) throw new HttpError(401, 'unauthorized', '口令不对');
  const { access, account } = issueTokens(rec);
  rec.rotatedAt = Date.now();
  await saveTenant(rec);
  clearResolveCache(rec.id);
  return { ok: true, accessToken: access, accountingToken: account };
}

// ── 激活码核销 ────────────────────────────────────────
async function activate(req) {
  if (!isSaas()) throw new HttpError(400, 'not_saas', '这是开源版部署，不需要激活');
  const token = String(req?.token || '').trim();
  const ctx = await resolveTenant(token);
  if (!ctx) {
    await sleep(AUTH_FAIL_DELAY_MS);
    throw new HttpError(401, 'unauthorized', '口令不对');
  }
  const code = normalizeCode(req?.code);
  if (!code || code.length < 8) throw new HttpError(400, 'invalid_code', '请输入激活码（形如 KB-XXXX-XXXX-XXXX）');

  const raw = await storage().get(codeKey(code));
  if (!raw) throw new HttpError(404, 'code_not_found', '激活码不存在，检查有没有输错');

  // 原子占位：并发下只允许一个请求核销同一个码
  const slot = await storage().incr(`used:${code}`);
  if (slot > 1) {
    await storage().decr(`used:${code}`).catch(() => {});
    throw new HttpError(409, 'code_used', '这个激活码已经被用过了');
  }

  try {
    const rec = JSON.parse(raw);
    if (rec.usedBy) throw new HttpError(409, 'code_used', '这个激活码已经被用过了');

    // 读最新的租户记录再改：解析口令用的缓存可能是一分钟前的，拿它回写会把这期间换的口令、加的时长盖掉
    const tenant = await loadTenant(ctx.tenant.id);
    if (!tenant) throw new HttpError(401, 'unauthorized', '口令不对');
    const now = Date.now();
    const base = Math.max(tenant.expireAt || 0, now); // 未到期就续期 → 顺延
    tenant.expireAt = base + Number(rec.days || 365) * DAY_MS;
    tenant.activatedAt = now;
    await saveTenant(tenant);
    await storage().set(codeKey(code), JSON.stringify({ ...rec, usedBy: tenant.id, usedAt: now }));
    clearResolveCache(tenant.id);
    return { ok: true, expireAt: tenant.expireAt, days: Number(rec.days || 365) };
  } catch (e) {
    await storage().decr(`used:${code}`).catch(() => {});
    throw e;
  }
}

// ── 运营管理（口令在 Vercel 环境变量 SAAS_ADMIN_TOKEN） ──
// 租户记录里能给运营方看的部分：加密的应用密钥、口令一概不出
function publicMeta(rec) {
  const { secretEnc, accessEnc, accountEnc, ...meta } = rec;
  return { ...meta, active: memberActive(rec) };
}

async function admin(req, headers) {
  const want = process.env.SAAS_ADMIN_TOKEN || '';
  const got = String(headers['x-admin-token'] || '');
  if (!want || !safeEqualText(got, want)) {
    await sleep(2000);
    throw new HttpError(401, 'unauthorized', '管理口令不对');
  }
  const action = String(req?.action || '');

  if (action === 'gencode') {
    const count = Math.min(Math.max(Number(req?.count) || 1, 1), 50);
    const days = Math.max(Number(req?.days) || 365, 1);
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = newCode();
      await storage().set(codeKey(code), JSON.stringify({ days, usedBy: null, createdAt: Date.now() }));
      await storage().sadd(CODES_SET, code);
      codes.push(code);
    }
    return { ok: true, codes, days, count };
  }

  if (action === 'codes') {
    const all = await storage().smembers(CODES_SET);
    const out = [];
    for (const code of all.slice(-200)) {
      const raw = await storage().get(codeKey(code));
      out.push({ code, ...(raw ? JSON.parse(raw) : { missing: true }) });
    }
    return { ok: true, codes: out };
  }

  if (action === 'list') {
    // baseToken 也列出来：用户口令丢了、只报得出自己飞书账本的网址时，靠它对上是哪个用户
    const keys = await storage().scan('t:*');
    const users = [];
    for (const k of keys.slice(0, 500)) {
      const rec = await loadTenant(k.slice(2));
      if (rec) users.push({ id: rec.id, appId: rec.appId, baseToken: rec.baseToken || '', boundAt: rec.boundAt || 0, expireAt: rec.expireAt || 0, active: memberActive(rec) });
    }
    users.sort((a, b) => b.boundAt - a.boundAt);
    return { ok: true, users, total: users.length };
  }

  if (action === 'show') {
    const rec = await loadTenant(String(req?.userId || ''));
    if (!rec) throw new HttpError(404, 'not_found', '没有这个用户');
    return { ok: true, user: publicMeta(rec) };
  }

  if (action === 'reset') {
    // 用户口令丢了：发一对新的给他，旧的作废。只能重置、不能查看——
    // 运营方拿到的永远是一串新口令，用户手里的旧口令随即失效，他会知道
    const rec = await loadTenant(String(req?.userId || ''));
    if (!rec) throw new HttpError(404, 'not_found', '没有这个用户');
    const { access, account } = issueTokens(rec);
    rec.rotatedAt = Date.now();
    await saveTenant(rec);
    clearResolveCache(rec.id);
    return { ok: true, userId: rec.id, accessToken: access, accountingToken: account };
  }

  if (action === 'grant') {
    const rec = await loadTenant(String(req?.userId || ''));
    if (!rec) throw new HttpError(404, 'not_found', '没有这个用户');
    const days = Number(req?.days);
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 3650) throw new HttpError(400, 'invalid_days', '天数不合法');
    const now = Date.now();
    rec.expireAt = days > 0 ? Math.max(rec.expireAt || 0, now) + days * DAY_MS : Math.max((rec.expireAt || 0) + days * DAY_MS, 0);
    await saveTenant(rec);
    clearResolveCache(rec.id);
    return { ok: true, userId: rec.id, expireAt: rec.expireAt };
  }

  throw new HttpError(400, 'unknown_action', `不支持的操作：${action}`);
}

// ── 到期提醒（Vercel Cron 每天跑一次：vercel.json 的 crons） ──
// 逻辑：扫出租户里「到期前 7 天 ~ 过期 14 天」的，向开过推送的设备发一条续费提醒（每 3 天最多一条）。
// 只给「有过推送订阅」的用户推；没开的用户会在看板顶部看到提醒条（前端 renew-bar）。
const RENEW_WINDOW_DAYS = 7;
const RENEW_REPEAT_MS = 3 * DAY_MS;
const RENEW_MAX_TENANTS = 300; // 单次上限，够小型服务用
// 上次提醒的时间单独存一个键，3 天后自己过期：不回写租户记录，免得和同时进行的激活、换口令互相覆盖
const RENEW_KEY = (id) => `rr:${id}`;

// 这个租户现在该不该收到续费提醒？（到期前 7 天 ~ 过期 14 天内，且 3 天内没提醒过）
function shouldRenewRemind(rec, now = Date.now()) {
  if (!rec || !rec.expireAt) return false;
  const left = Math.ceil((rec.expireAt - now) / DAY_MS);
  if (left > RENEW_WINDOW_DAYS || left < -14) return false;
  if (rec.renewRemindedAt && now - rec.renewRemindedAt < RENEW_REPEAT_MS) return false;
  return true;
}

async function cronRemind(headers = {}) {
  // 鉴权：在 Vercel 配了 CRON_SECRET 时，Vercel Cron 会带 Authorization: Bearer <CRON_SECRET>
  const want = process.env.CRON_SECRET || '';
  if (want) {
    const got = String(headers.authorization || '');
    if (!safeEqualText(got, `Bearer ${want}`)) {
      await sleep(1000);
      throw new HttpError(401, 'unauthorized', 'cron 口令不对');
    }
  }
  if (!isSaas()) return { ok: true, skipped: 'not_saas', message: '这是开源版部署，没有到期提醒' };
  if (freeMode()) return { ok: true, skipped: 'free', message: '免费模式（SAAS_FREE=1），不发到期提醒' };

  const keys = await storage().scan('t:*');
  const now = Date.now();
  let candidates = 0;
  let sent = 0;

  for (const k of keys.slice(0, RENEW_MAX_TENANTS)) {
    const rec = await loadTenant(k.slice(2));
    if (!shouldRenewRemind(rec, now)) continue; // 先看到期窗口，窗口外的不多读一次存储
    const last = Number(await storage().get(RENEW_KEY(rec.id))) || 0;
    if (!shouldRenewRemind({ ...rec, renewRemindedAt: Math.max(last, rec.renewRemindedAt || 0) }, now)) continue;
    candidates++;
    try {
      const n = await runWithTenant(contextFromRecord(rec), async () => {
        const { listSubs, sendToAll } = require('./push.js');
        const subs = await listSubs();
        if (!subs.length) return 0;
        const left = Math.ceil((rec.expireAt - now) / DAY_MS);
        // 按每台设备选的语言（订阅里存着）
        const message = (lang) =>
          lang === 'en'
            ? {
                title: 'Kongbei Ledger · Membership ending',
                body:
                  left > 0
                    ? `Your membership ends in ${left} day${left === 1 ? '' : 's'}. Renew to keep logging (your records stay in your own Feishu).`
                    : 'Your membership has expired: you can still see your records, but logging and editing are paused. Renew and you pick up right where you left off; nothing is lost.',
              }
            : {
                title: '空杯记账 · 会员要到期了',
                body: left > 0 ? `还有 ${left} 天到期，续上才能继续记账（账都还在你自己的飞书里）。` : '已经到期：账还能看，记账和改账暂停了；续上马上恢复，数据一条没少。',
              };
        const results = await sendToAll((lang) => ({ ...message(lang), url: '/', tag: 'renew' }), subs);
        return results.filter((r) => r.ok).length;
      });
      // 推没推成功都记时间，避免反复打扰；下一个 3 天窗口再试
      await storage().set(RENEW_KEY(rec.id), String(now), Math.ceil(RENEW_REPEAT_MS / 1000));
      sent += n;
    } catch (e) {
      console.error('到期提醒失败', rec.id, e.message);
    }
  }
  return { ok: true, tenants: keys.length, candidates, sent };
}

module.exports = {
  withTenant,
  extractToken,
  membershipExpired,
  EXPIRED_BODY,
  bind,
  status,
  rotate,
  activate,
  admin,
  cronRemind,
  createAppBegin,
  createAppPoll,
  HttpError,
  // 供测试用
  FIELDS_SPEC,
  LEDGER_NAME,
  categoryFieldSpec,
  shouldRenewRemind,
  finishBinding,
  clientIp,
  rateLimit,
  RATE_LIMITS,
};
