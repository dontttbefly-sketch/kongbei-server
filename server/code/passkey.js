'use strict';
// 空杯记账 · 面容 ID 登录（WebAuthn 通行密钥）：开启、登录、列出、删除。开源版、线上版都能用（2026-10-16）
//
// POST /api/passkey（api/passkey.js），body 是 JSON：
//   {op:'login-begin'}                          → 登录前拿参数（谁都能要）
//   {op:'login-finish', credential}             → 验签通过回 {token}：就是平时输的那串口令，看板照常用它
//   {op:'register-begin', token}                → 开启前拿参数（要先用口令登录）
//   {op:'register-finish', token, credential, device}
//   {op:'list', token} / {op:'remove', token, id}
// 存在哪（只存凭据 ID 和公钥，都不是秘密）：
//   开源版：飞书里自动建的「登录设备」表，一台设备一行（和推送订阅一样）
//   线上版：租户记录里的 passkeys，另有 pk:<凭据 ID> → 租户 ID 的索引（登录时还不知道是谁，靠它找人）
// 挑战不用存（webauthn.js：HMAC 签名 + 3 分钟过期）；线上版另把用过的挑战记 5 分钟，防同一个登录签名被重放

const crypto = require('node:crypto');
const { safeEqual } = require('./index.js');
const feishu = require('./feishu.js');
const { configOf, isSaas, storage, resolveTenant, loadTenant, saveTenant, decryptText } = require('./tenant.js');
const { rateLimit } = require('./saas.js');
const wa = require('./webauthn.js');

const TABLE = '登录设备';
const FIELDS = [
  { field_name: '凭据', type: 1 },
  { field_name: '公钥', type: 1 },
  { field_name: '设备', type: 1 },
  { field_name: '开启时间', type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
];
const MAX_PASSKEYS = 10;
const AUTH_FAIL_DELAY_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function reply(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

// 网站是哪个：通行密钥按域名认（rpId），签名里的来源也要是它。本地开发 localhost 用 http
function siteOf(headers) {
  const host = String(headers['x-forwarded-host'] || headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const hostname = host.replace(/:\d+$/, '');
  if (!hostname) throw new HttpError(400, 'bad_host', '认不出是哪个网址');
  const local = hostname === 'localhost' || hostname === '127.0.0.1';
  return { rpId: hostname, origin: `${local ? 'http' : 'https'}://${host}` };
}

// 签挑战的钥匙：线上版用 SAAS_SECRET，开源版用两串口令（都只在服务器上）
function secret() {
  const base = isSaas() ? process.env.SAAS_SECRET : `${configOf('API_TOKEN') || ''}\n${configOf('ACCOUNTING_SECRET') || ''}`;
  if (!base || base.length < 8) throw new HttpError(500, 'missing_env', '服务器缺少口令配置');
  return crypto.createHash('sha256').update(`kb-passkey-v1|${base}`).digest();
}

// 凭口令认人：线上版只认看板口令（记账口令跟着快捷指令到处走，不能拿它开面容登录）
async function whoami(token) {
  const t = String(token || '').trim();
  if (t) {
    if (isSaas()) {
      const ctx = await resolveTenant(t).catch(() => null);
      if (ctx && ctx.config.API_TOKEN === t) return { saas: true, id: ctx.tenant.id };
    } else {
      const want = configOf('API_TOKEN');
      if (want && safeEqual(t, want)) return { saas: false, id: 'self' };
    }
  }
  await sleep(AUTH_FAIL_DELAY_MS);
  throw new HttpError(401, 'unauthorized', '口令不对');
}

// ── 存储：线上版在租户库，开源版在飞书表 ─────────────────────
const pkIndex = (credId) => `pk:${credId}`;

// 开源版的设备列表在函数实例里缓存一分钟：登录时先查缓存，乱发的登录请求不至于把飞书额度刷掉
let selfCache = { at: 0, list: null };
async function selfList({ fresh = false } = {}) {
  if (!fresh && selfCache.list && Date.now() - selfCache.at < 60_000) return selfCache.list;
  const t = await feishu.findTable(TABLE);
  let list = [];
  if (t) {
    const items = await feishu.search(t, { field_names: FIELDS.map((f) => f.field_name) });
    list = items.flatMap((it) => {
      try {
        const key = JSON.parse(feishu.cellText(it.fields['公钥']));
        return [{ recordId: it.record_id, id: feishu.cellText(it.fields['凭据']), alg: key.alg, jwk: key.jwk, signCount: key.signCount || 0, device: feishu.cellText(it.fields['设备']), createdAt: Number(it.fields['开启时间']) || 0 }];
      } catch {
        return [];
      }
    });
  }
  selfCache = { at: Date.now(), list };
  return list;
}

const store = {
  async list(who) {
    if (who.saas) return (await loadTenant(who.id))?.passkeys ?? [];
    return selfList({ fresh: true });
  },
  async add(who, pk) {
    if (who.saas) {
      const owner = await storage().get(pkIndex(pk.id));
      if (owner && owner !== who.id) throw new HttpError(409, 'passkey_taken', '这把通行密钥已经连在别的账本上了');
      const rec = await loadTenant(who.id); // 读最新的一份再改，别盖掉同时进行的激活、换口令
      if (!rec) throw new HttpError(401, 'unauthorized', '口令不对');
      const rest = (rec.passkeys ?? []).filter((p) => p.id !== pk.id);
      if (rest.length >= MAX_PASSKEYS) throw new HttpError(400, 'too_many_passkeys', `最多开启 ${MAX_PASSKEYS} 台设备，先删掉一台不用的`);
      rec.passkeys = [...rest, pk];
      await saveTenant(rec);
      await storage().set(pkIndex(pk.id), rec.id);
      return;
    }
    const list = await selfList({ fresh: true });
    if (list.length >= MAX_PASSKEYS) throw new HttpError(400, 'too_many_passkeys', `最多开启 ${MAX_PASSKEYS} 台设备，先删掉一台不用的`);
    const t = await feishu.findTable(TABLE, FIELDS);
    const same = list.find((p) => p.id === pk.id);
    const fields = { 凭据: pk.id, 公钥: JSON.stringify({ alg: pk.alg, jwk: pk.jwk, signCount: pk.signCount }), 设备: pk.device, 开启时间: pk.createdAt };
    if (same) await feishu.call(`${feishu.tables()}/${t}/records/${same.recordId}`, { method: 'PUT', body: { fields } });
    else await feishu.call(`${feishu.tables()}/${t}/records`, { method: 'POST', body: { fields } });
    selfCache = { at: 0, list: null };
  },
  async remove(who, id) {
    if (who.saas) {
      const rec = await loadTenant(who.id);
      if (!rec) return 0;
      const before = (rec.passkeys ?? []).length;
      rec.passkeys = (rec.passkeys ?? []).filter((p) => p.id !== id);
      if (rec.passkeys.length === before) return 0;
      await saveTenant(rec);
      if ((await storage().get(pkIndex(id))) === rec.id) await storage().del(pkIndex(id));
      return 1;
    }
    const hit = (await selfList({ fresh: true })).find((p) => p.id === id);
    if (!hit) return 0;
    const t = await feishu.findTable(TABLE);
    await feishu.call(`${feishu.tables()}/${t}/records/${hit.recordId}`, { method: 'DELETE' });
    selfCache = { at: 0, list: null };
    return 1;
  },
  // 登录：凭凭据 ID 找到是谁、它的公钥，和验签通过后要给的口令
  async find(credId) {
    if (isSaas()) {
      const tid = await storage().get(pkIndex(credId));
      if (!tid) return null;
      const rec = await loadTenant(tid);
      const pk = rec?.passkeys?.find((p) => p.id === credId);
      return pk ? { who: { saas: true, id: rec.id }, pk, token: () => decryptText(rec.accessEnc) } : null;
    }
    // 缓存里没有、而且缓存不是刚拉的：再拉一次（可能是别的函数实例刚开启的）。最多 5 秒一次，乱发的请求刷不动飞书
    let pk = (await selfList()).find((p) => p.id === credId);
    if (!pk && Date.now() - selfCache.at > 5_000) pk = (await selfList({ fresh: true })).find((p) => p.id === credId);
    return pk ? { who: { saas: false, id: 'self' }, pk, token: () => configOf('API_TOKEN') } : null;
  },
};

// 开源版没有存储：用过的挑战只在这个函数实例里记一下（尽力而为；挑战本身 3 分钟就过期）
const usedHere = new Map();
async function markChallengeUsed(challenge) {
  const nonce = wa.challengeNonce(challenge);
  if (isSaas()) {
    const n = await storage().incr(`pkc:${nonce}`);
    if (n === 1) await storage().expire(`pkc:${nonce}`, 300);
    return n === 1;
  }
  const now = Date.now();
  for (const [k, at] of usedHere) if (now - at > 300_000) usedHere.delete(k);
  if (usedHere.has(nonce)) return false;
  usedHere.set(nonce, now);
  return true;
}

const deviceName = (s) => String(s || '').slice(0, 40) || '设备';
const clientChallenge = (credential) => {
  try {
    return JSON.parse(wa.fromB64u(credential?.response?.clientDataJSON).toString('utf8')).challenge || '';
  } catch {
    return '';
  }
};

async function handle(event) {
  if (event.method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' });
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let req;
  try {
    req = JSON.parse(event.body || '{}');
  } catch {
    return reply(400, { ok: false, error: 'bad_json' });
  }
  if (!req || typeof req !== 'object') return reply(400, { ok: false, error: 'bad_json' });

  try {
    const site = siteOf(headers);
    switch (req.op) {
      case 'login-begin':
        return reply(200, { ok: true, options: { challenge: wa.makeChallenge(secret(), 'l'), rpId: site.rpId, timeout: 120_000, userVerification: 'required', allowCredentials: [] } });

      case 'login-finish': {
        if (isSaas()) await rateLimit('passkey', headers);
        const cred = req.credential;
        const credId = wa.b64u(wa.fromB64u(cred?.rawId || cred?.id));
        const found = credId ? await store.find(credId) : null;
        if (!found) {
          await sleep(AUTH_FAIL_DELAY_MS);
          throw new HttpError(401, 'passkey_unknown', '这台设备上的面容 ID 登录已经关掉了，或者是别的账本的：先用口令登录，再到「设置 → 登录」重新开启');
        }
        // 线上版：通行密钥里记的用户 ID 要和找到的租户对得上
        const handleId = cred?.response?.userHandle ? wa.fromB64u(cred.response.userHandle).toString('utf8') : '';
        if (found.who.saas && handleId && handleId !== found.who.id) throw new HttpError(401, 'passkey_invalid', '面容 ID 验证没通过');
        const key = secret();
        // 签名计数不回写：iCloud 钥匙串的通行密钥计数一直是 0
        wa.verifyAuthentication({ credential: cred, stored: found.pk, checkChallenge: (c) => wa.checkChallenge(key, c, 'l'), origin: site.origin, rpId: site.rpId });
        if (!(await markChallengeUsed(clientChallenge(cred)))) throw new HttpError(401, 'passkey_invalid', '这次登录已经用过了，再点一次');
        const token = found.token();
        if (!token) throw new HttpError(500, 'missing_env', '服务器缺少口令配置');
        return reply(200, { ok: true, token });
      }

      case 'register-begin': {
        const who = await whoami(req.token);
        const existing = await store.list(who);
        const name = who.saas ? `空杯记账 · ${who.id}` : '空杯记账';
        return reply(200, {
          ok: true,
          options: {
            challenge: wa.makeChallenge(secret(), 'r', who.id),
            rp: { id: site.rpId, name: '空杯记账' },
            user: { id: wa.b64u(Buffer.from(who.saas ? who.id : 'kongbei-self')), name, displayName: name },
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 },
              { type: 'public-key', alg: -8 },
            ],
            authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
            attestation: 'none',
            timeout: 120_000,
            excludeCredentials: existing.map((p) => ({ type: 'public-key', id: p.id })),
          },
        });
      }

      case 'register-finish': {
        const who = await whoami(req.token);
        const key = secret();
        const got = wa.verifyRegistration({ credential: req.credential, checkChallenge: (c) => wa.checkChallenge(key, c, 'r', who.id), origin: site.origin, rpId: site.rpId });
        const pk = { id: got.id, alg: got.alg, jwk: got.jwk, signCount: got.signCount, transports: got.transports, device: deviceName(req.device), createdAt: Date.now() };
        await store.add(who, pk);
        return reply(200, { ok: true, passkey: { id: pk.id, device: pk.device, createdAt: pk.createdAt } });
      }

      case 'list': {
        const who = await whoami(req.token);
        const list = await store.list(who);
        return reply(200, { ok: true, passkeys: list.map((p) => ({ id: p.id, device: p.device, createdAt: p.createdAt })) });
      }

      case 'remove': {
        const who = await whoami(req.token);
        const removed = await store.remove(who, String(req.id || ''));
        return reply(200, { ok: true, removed });
      }

      default:
        return reply(400, { ok: false, error: 'bad_op' });
    }
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { ok: false, error: e.code, message: e.message });
    if (e instanceof wa.WebAuthnError) return reply(400, { ok: false, error: 'passkey_invalid', message: `面容 ID 验证没通过：${e.message}` });
    console.error(e);
    return reply(500, { ok: false, error: 'internal_error', message: '服务内部错误' });
  }
}

module.exports = { handle, siteOf, store, TABLE, FIELDS, _resetCache: () => ((selfCache = { at: 0, list: null }), usedHere.clear()) };
