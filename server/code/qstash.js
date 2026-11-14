'use strict';
// 空杯记账 · Upstash QStash（备注提醒的定时器）：直接用 HTTP 接口，不加 SDK。
//   预约：POST {QSTASH_URL}/v2/publish/<目标网址>，Upstash-Not-Before = 几点送到（秒），Upstash-Deduplication-Id 防重复
//   回调：QStash 带着 Upstash-Signature（HS256 的 JWT）来敲 /api/remind，用两把签名密钥核对，确认真是它发的
// 环境变量（Vercel 上装 Upstash QStash 集成时自动加好）：QSTASH_URL、QSTASH_TOKEN、QSTASH_CURRENT_SIGNING_KEY、QSTASH_NEXT_SIGNING_KEY

const crypto = require('crypto');

const configured = () => !!(process.env.QSTASH_TOKEN && process.env.QSTASH_CURRENT_SIGNING_KEY);

// 预约一条：到 at（毫秒）时把 body POST 给 url。dedupId 一样的 90 天内只送一次
async function publish(url, body, { at, dedupId, retries = 3 } = {}) {
  const base = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${process.env.QSTASH_TOKEN}`, 'Content-Type': 'application/json', 'Upstash-Retries': String(retries) };
  if (at) headers['Upstash-Not-Before'] = String(Math.floor(at / 1000));
  if (dedupId) headers['Upstash-Deduplication-Id'] = dedupId;
  const res = await fetch(`${base}/v2/publish/${url}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`QStash ${res.status}: ${data.error || ''}`);
  return data.messageId || null;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
// 去掉结尾的 =，再统一成 base64url（QStash 的 body 摘要是 base64url；标准 base64 的 + / 也认）
const strip = (s) => String(s || '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// 核对回调：签名对得上当前或下一把密钥、来自 Upstash、没过期、body 的摘要对得上（body 要原样的字符串）
function verify(signature, rawBody, { keys = [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY], now = Date.now(), toleranceSec = 30 } = {}) {
  const parts = String(signature || '').split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  const signed = keys.filter(Boolean).some((k) => {
    const want = Buffer.from(b64u(crypto.createHmac('sha256', k).update(`${h}.${p}`).digest()));
    const got = Buffer.from(strip(s));
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  });
  if (!signed) return false;
  let c;
  try {
    c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  const t = now / 1000;
  if (c.iss !== 'Upstash') return false;
  if (c.exp && t > c.exp + toleranceSec) return false;
  if (c.nbf && t < c.nbf - toleranceSec) return false;
  const hash = b64u(crypto.createHash('sha256').update(rawBody || '').digest());
  return strip(c.body) === strip(hash);
}

module.exports = { configured, publish, verify };
