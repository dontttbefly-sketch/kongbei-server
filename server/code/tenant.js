'use strict';
// 空杯记账 · 租户层（线上版 / SaaS 专用地基）
//
// 一份代码、两种部署的唯一分叉点就在这里：
//   - 开源版（用户自己部署）：不配 SAAS_MODE，configOf() 全部回退 process.env，行为与改造前完全一致
//   - 线上版（我们运营，my.kongbei.xyz）：配 SAAS_MODE=1，请求带着租户口令进来 → 解析出租户 → 把该租户的凭证
//     注入 AsyncLocalStorage 上下文 → 后面所有 env('FEISHU_APP_ID') 这类调用自动拿到租户的值，一行不用改
//
// 隐私设计（不存账单、凭证加密、代码公开、用户随时能吊销）：
//   - 服务器不存任何账单：这里只有租户元数据（到期时间、表 ID、加密凭证），没有一笔账
//   - 凭证与口令 AES-256-GCM 加密存储，仅在一次请求期间于内存中解密，用完随请求结束丢弃
//   - 用户随时可在飞书后台删除应用 → 这里的一切立即失效
//
// 零依赖：只用 node 内置模块 + fetch。

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

// ── 上下文 ──────────────────────────────────────────
const als = new AsyncLocalStorage();

// 读配置：租户上下文优先，回退环境变量（开源版 / 线上版自身的运营配置）
function configOf(key) {
  const ctx = als.getStore();
  if (ctx && ctx.config && ctx.config[key] != null) return ctx.config[key];
  return process.env[key];
}
// 进程内缓存键：不同租户的 token/表缓存必须隔离（同一个函数实例会服务多个租户）
const cacheKey = () => als.getStore()?.key ?? 'env';
const currentTenant = () => als.getStore() ?? null;
const runWithTenant = (tenant, fn) => als.run(tenant, fn);

// SaaS 模式开关：显式配置，开源版部署永远不会误开
const isSaas = () => process.env.SAAS_MODE === '1';

// ── 存储（Upstash Redis REST；测试可注入内存实现） ──────
let storeImpl = null;
function setStorage(impl) {
  storeImpl = impl;
}
function storage() {
  if (!storeImpl) storeImpl = redisStorage();
  return storeImpl;
}

function redisStorage() {
  // 兼容两种环境变量命名：Upstash 官方集成（UPSTASH_REDIS_REST_*）和旧版 Vercel KV（KV_REST_API_*）——
  // 在 Vercel 控制台装「Upstash Redis」集成时注入的是前者，老项目迁移过来可能是后者，两种都能跑
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  async function cmd(args) {
    if (!url || !token) throw new Error('缺少 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（或 KV_REST_API_URL / KV_REST_API_TOKEN）');
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(`存储出错：${data.error}`);
    return data.result ?? null;
  }
  return {
    get: (k) => cmd(['GET', k]),
    // ex：几秒后自己过期（不传 = 永久）
    set: (k, v, ex) => cmd(ex ? ['SET', k, v, 'EX', ex] : ['SET', k, v]),
    del: (k) => cmd(['DEL', k]),
    sadd: (k, v) => cmd(['SADD', k, v]),
    smembers: (k) => cmd(['SMEMBERS', k]).then((r) => (Array.isArray(r) ? r : [])),
    incr: (k) => cmd(['INCR', k]),
    decr: (k) => cmd(['DECR', k]),
    expire: (k, s) => cmd(['EXPIRE', k, s]),
    async scan(pattern) {
      let cursor = '0';
      const keys = [];
      do {
        const r = await cmd(['SCAN', cursor, 'MATCH', pattern, 'COUNT', 100]);
        cursor = String(Array.isArray(r) ? r[0] : '0');
        keys.push(...((Array.isArray(r) && r[1]) || []));
      } while (cursor !== '0');
      return keys;
    },
  };
}

// 内存实现：单元测试、本地开发用。进程重启即清空。过期和 Redis 一样：SET 不带 ex 会清掉过期时间，INCR 保留
function memoryStorage() {
  const m = new Map();
  const s = new Map();
  const exp = new Map(); // 键 → 过期时刻（毫秒）
  const alive = (k) => {
    const at = exp.get(k);
    if (at != null && Date.now() >= at) {
      m.delete(k);
      exp.delete(k);
    }
    return m.has(k);
  };
  return {
    get: async (k) => (alive(k) ? m.get(k) : null),
    set: async (k, v, ex) => {
      m.set(k, String(v));
      if (ex) exp.set(k, Date.now() + ex * 1000);
      else exp.delete(k);
    },
    del: async (k) => {
      m.delete(k);
      exp.delete(k);
    },
    sadd: async (k, v) => void s.set(k, new Set([...(s.get(k) ?? []), String(v)])),
    smembers: async (k) => [...(s.get(k) ?? [])],
    incr: async (k) => {
      const n = Number(alive(k) ? m.get(k) : 0) + 1;
      m.set(k, String(n));
      return n;
    },
    decr: async (k) => {
      const n = Number(alive(k) ? m.get(k) : 0) - 1;
      m.set(k, String(n));
      return n;
    },
    expire: async (k, sec) => (alive(k) ? (exp.set(k, Date.now() + sec * 1000), 1) : 0),
    scan: async (pattern) => {
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return [...m.keys()].filter((k) => alive(k) && re.test(k));
    },
  };
}

// ── 加密（凭证与口令的静态加密） ──────────────────────
// SAAS_SECRET：运营方环境的随机长串（Vercel 环境变量）。泄露它等于泄露全部加密凭证，
// 所以它只存在于环境变量里，不进代码库、不进日志。
function masterKey() {
  const raw = process.env.SAAS_SECRET;
  if (!raw || raw.length < 16) throw new Error('缺少环境变量 SAAS_SECRET（至少 16 位随机串）');
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function encryptText(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function decryptText(packed) {
  const parts = String(packed || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密文格式不对');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(parts[1], 'base64url'));
  d.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8');
}

// ── 口令 ────────────────────────────────────────────
// 格式：<用户ID>.<随机串>，如 u3f9a1c2b4d.xY7...  。用户 ID 可读，便于「凭口令找到租户」
const ID_RE = /^u[0-9a-f]{10}$/;
const newUserId = () => 'u' + crypto.randomBytes(5).toString('hex');
const newToken = (userId) => `${userId}.${crypto.randomBytes(18).toString('base64url')}`;

function parseToken(token) {
  const s = String(token || '').trim();
  const i = s.indexOf('.');
  if (i < 0) return null;
  const userId = s.slice(0, i);
  const secret = s.slice(i + 1);
  if (!ID_RE.test(userId) || secret.length < 16) return null;
  return { userId, secret };
}

function safeEqualText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ── 租户记录 ─────────────────────────────────────────
// { id, createdAt, expireAt, appId, secretEnc, accessEnc, accountEnc, baseToken, tableId, tableUrl }
// 注意：这里没有、也永远不会有任何账单字段。
const tenantKey = (id) => `t:${id}`;
const appIndexKey = (appId) => `app:${appId}`;

async function loadTenant(userId) {
  const raw = await storage().get(tenantKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveTenant(rec) {
  await storage().set(tenantKey(rec.id), JSON.stringify(rec));
  await storage().set(appIndexKey(rec.appId), rec.id);
}

async function findTenantByApp(appId) {
  const id = await storage().get(appIndexKey(appId));
  return id ? loadTenant(id) : null;
}

// 免费模式（2026-10-19 用户：「直接先做成免费的样子，后面要加我就直接加」）：线上版环境变量 SAAS_FREE=1 时谁都算有效，
// 记账、改账不拦；看板不显示会员、到期、激活码；到期提醒不发。关掉它，会员制原样回来（租户记录里的 expireAt 一直照常记着）
const freeMode = () => String(process.env.SAAS_FREE ?? '').trim() === '1';

// 会员是否有效。expireAt 为毫秒时间戳；0 或过去 = 未开通/已过期（免费模式下一律有效）
const memberActive = (rec, now = Date.now()) => !!rec && (freeMode() || rec.expireAt > now);

// ── 租户解析（把请求里的口令换成租户上下文） ─────────────
const resolveCache = new Map(); // token 哈希 -> { ctx, at }，进程内缓存 60 秒，降低存储往返
const RESOLVE_TTL_MS = 60 * 1000;

function clearResolveCache(userId) {
  for (const [k, v] of resolveCache) if (!userId || v.ctx.tenant.id === userId) resolveCache.delete(k);
}

// token → { key, tenant, config }；找不到或口令不对返回 null
async function resolveTenant(token) {
  const parsed = parseToken(token);
  if (!parsed) return null;

  const cacheK = crypto.createHash('sha256').update(String(token)).digest('hex');
  const hit = resolveCache.get(cacheK);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.ctx;

  const rec = await loadTenant(parsed.userId);
  if (!rec) return null;

  // 口令比对：访问口令、记账口令都可能出现在请求里（各自用途不同）
  const access = decryptText(rec.accessEnc);
  const account = decryptText(rec.accountEnc);
  const t = String(token);
  if (!safeEqualText(t, access) && !safeEqualText(t, account)) return null;

  const ctx = {
    key: rec.id,
    tenant: rec,
    config: {
      FEISHU_APP_ID: rec.appId,
      FEISHU_APP_SECRET: decryptText(rec.secretEnc),
      BASE_TOKEN: rec.baseToken,
      TABLE_ID: rec.tableId,
      API_TOKEN: access, // 既有接口拿 env('API_TOKEN') 比对的正是请求带来的口令 → 自动对上
      ACCOUNTING_SECRET: account,
    },
  };
  resolveCache.set(cacheK, { ctx, at: Date.now() });
  return ctx;
}

// 从租户记录直接构造上下文（不校验口令）：只给「服务器间调用」用——
// 如 QStash 到点回调 /api/remind?tid=xxx 发备注提醒，调用方靠 QStash 签名保护，不带用户口令
function contextFromRecord(rec) {
  return {
    key: rec.id,
    tenant: rec,
    config: {
      FEISHU_APP_ID: rec.appId,
      FEISHU_APP_SECRET: decryptText(rec.secretEnc),
      BASE_TOKEN: rec.baseToken,
      TABLE_ID: rec.tableId,
    },
  };
}

// ── 激活码 ───────────────────────────────────────────
const codeKey = (code) => `code:${code}`;
const CODES_SET = 'codes';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混的 I/L/O/0/1
function newCode() {
  const block = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  return `KB-${block()}-${block()}-${block()}`;
}
const normalizeCode = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

module.exports = {
  // 上下文
  configOf,
  cacheKey,
  currentTenant,
  runWithTenant,
  isSaas,
  // 存储
  storage,
  setStorage,
  memoryStorage,
  redisStorage,
  // 加密
  encryptText,
  decryptText,
  // 口令
  newUserId,
  newToken,
  parseToken,
  safeEqualText,
  // 租户
  loadTenant,
  saveTenant,
  findTenantByApp,
  memberActive,
  freeMode,
  resolveTenant,
  clearResolveCache,
  contextFromRecord,
  // 激活码
  codeKey,
  CODES_SET,
  newCode,
  normalizeCode,
  // 常量
  RESOLVE_TTL_MS,
};
