'use strict';
// 空杯记账 · 线上版（SaaS）接口的 HTTP 适配层（api/saas.js 用）
// 业务逻辑在 saas.js，这里只做 Vercel req/res ↔ 纯函数的转换

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const rawBody = (body) => (body == null ? '' : typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : JSON.stringify(body));

// fn(body, headers) → 业务结果；抛 HttpError 时按其状态码返回
function endpoint(fn) {
  return async (req, res) => {
    if (String(req.method || '').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });

    let body = {};
    try {
      body = JSON.parse(rawBody(req.body) || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'bad_json' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) headers[k.toLowerCase()] = String(v);

    const { HttpError } = require('./saas.js');
    try {
      return json(res, 200, await fn(body, headers));
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { ok: false, error: e.code, message: e.message });
      console.error(e);
      return json(res, 500, { ok: false, error: 'internal_error', message: '服务内部错误' });
    }
  };
}

module.exports = { endpoint };
