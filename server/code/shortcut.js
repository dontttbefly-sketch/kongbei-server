'use strict';
// 空杯记账 · 专属记账地址：看板凭访问口令换一条「专属记账地址」，复制进记账快捷指令的导入问题
//
// POST /api/shortcut   Content-Type: text/plain（和 /api/records 一样是简单请求）
//   body: {"token": "看板访问口令"}
//   resp: {"ok": true, "url": "https://<域名>/api/accounting?key=<ACCOUNTING_SECRET>"}
//         没配 ACCOUNTING_SECRET 时 url 是 null，看板提示去 Vercel 加环境变量
// 不碰飞书，不占飞书额度。地址里带着记账口令：拿到看板口令的人本来就能看全部账，这里只多给了「能记账」

const { safeEqual } = require('./index.js');
const { configOf } = require('./tenant.js');
const { withTenant } = require('./saas.js');

const AUTH_FAIL_DELAY_MS = 3000; // 和读接口一样：口令错误时延迟响应，拖慢逐个试口令
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reply(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

// 地址用请求进来的域名拼：自定义域名、vercel.app、本地开发都对
function origin(headers) {
  const host = headers['x-forwarded-host'] || headers.host;
  const proto = (headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

async function handle(event) {
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (event.method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' });
  let req;
  try {
    req = JSON.parse(event.body || '{}');
  } catch {
    return reply(400, { ok: false, error: 'bad_json' });
  }
  const want = configOf('API_TOKEN');
  if (!want || !req || !req.token || !safeEqual(req.token, want)) {
    await sleep(AUTH_FAIL_DELAY_MS);
    return reply(401, { ok: false, error: 'unauthorized' });
  }
  const secret = configOf('ACCOUNTING_SECRET');
  const base = origin(headers);
  return reply(200, { ok: true, url: secret && base ? `${base}/api/accounting?key=${encodeURIComponent(secret)}` : null });
}

// 双轨入口：线上版先解析租户、注入上下文（返回的专属记账地址自动带该租户的记账口令）
module.exports = { handle: withTenant(handle) };
