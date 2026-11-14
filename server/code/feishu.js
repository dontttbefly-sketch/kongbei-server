'use strict';
// 空杯记账 · 飞书小工具（备注提醒、推送订阅用）：取 token、调接口、按名字找表（没有就建）。
// 读接口 index.js / 记账 accounting.js / 改账 edit.js 各有自己的一份，这里给新功能共用

const FEISHU = 'https://open.feishu.cn/open-apis';
const { configOf, cacheKey } = require('./tenant.js');

class FeishuError extends Error {
  constructor(code, msg) {
    super(`飞书返回错误：${code} ${msg}`);
    this.code = code;
  }
}
// 双轨：线上版从租户上下文取（tenant.js 注入），开源版回退 process.env
const env = (k) => {
  const v = configOf(k);
  if (!v) throw new Error(`缺少环境变量：${k}`);
  return v;
};

// 取 token 的接口不计飞书调用额度；按 cacheKey 隔离（同一实例可能服务多个租户）
const tokenCaches = new Map();
function tokenSlot() {
  const k = cacheKey();
  let slot = tokenCaches.get(k);
  if (!slot) tokenCaches.set(k, (slot = { value: '', expiresAt: 0 }));
  return slot;
}

async function call(path, { method = 'GET', body } = {}) {
  const slot = tokenSlot();
  if (!slot.value || Date.now() >= slot.expiresAt) {
    const res = await fetch(`${FEISHU}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: env('FEISHU_APP_ID'), app_secret: env('FEISHU_APP_SECRET') }),
      signal: AbortSignal.timeout(6000),
    });
    const d = await res.json();
    if (d.code !== 0) throw new FeishuError(d.code, d.msg);
    slot.value = d.tenant_access_token;
    slot.expiresAt = Date.now() + (d.expire - 300) * 1000;
  }
  const res = await fetch(`${FEISHU}${path}`, {
    method,
    headers: { Authorization: `Bearer ${slot.value}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const d = await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}` }));
  if (d.code !== 0) throw new FeishuError(d.code, d.msg);
  return d.data || {};
}

const tables = () => `/bitable/v1/apps/${env('BASE_TOKEN')}/tables`;

// 按名字找表；create 时没有就按 fields 建一张。表 id 在函数实例里缓存
const tableIds = new Map();
async function findTable(name, fields) {
  const key = `${env('BASE_TOKEN')}/${name}`;
  if (tableIds.has(key)) return tableIds.get(key);
  let pageToken = '';
  do {
    const d = await call(`${tables()}?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`);
    const hit = (d.items || []).find((t) => t.name === name);
    if (hit) return tableIds.set(key, hit.table_id), hit.table_id;
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  if (!fields) return '';
  const d = await call(tables(), { method: 'POST', body: { table: { name, default_view_name: '全部', fields } } });
  tableIds.set(key, d.table_id);
  return d.table_id;
}

async function search(tableId, body) {
  const out = [];
  let pageToken = '';
  do {
    const d = await call(`${tables()}/${tableId}/records/search?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`, { method: 'POST', body: { automatic_fields: false, ...body } });
    out.push(...(d.items || []));
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  return out;
}

// 文本单元格：字符串，或 [{type,text}] 片段数组
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(cellText).join('');
  if (typeof v === 'object') return v.text != null ? String(v.text) : '';
  return '';
}

module.exports = { call, tables, findTable, search, cellText, FeishuError, env, _reset: () => (tokenCaches.clear(), tableIds.clear()) };
