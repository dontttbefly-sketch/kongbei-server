'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { FEISHU_APP_ID: 'test-app', FEISHU_APP_SECRET: 'test-secret', BASE_TOKEN: 'test-base', TABLE_ID: 'test-table', API_TOKEN: 'test-token' });
const settings = require('./settings.js');
const records = require('./index.js');
const edit = require('./edit.js');

test('新旧名称读回稳定分类，编辑账目时写入当前显示名', async () => {
  const originalFetch = global.fetch;
  const originalSettings = settings.getSettings;
  const bodies = [];
  settings.getSettings = async () => ({ names: { '🍲一日三餐': '🍝美食', '💳收入': '💰进账' }, aliases: { '🍲一日三餐': ['🍜餐饮'] } });
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'test', expire: 7200 });
    if (String(url).includes('/records/search')) return Response.json({ code: 0, data: { items: [
      { record_id: 'recTest1', fields: { 金额: -20, 记账日期: 1790762617539, 账单类目: '🍜餐饮', 备注: '旧账' } },
      { record_id: 'recTest2', fields: { 金额: 100, 记账日期: 1790762617539, 账单类目: '💰进账', 备注: '收入' } },
    ], has_more: false } });
    if (String(url).includes('/records/recTest1') && init.method === 'PUT') {
      bodies.push(JSON.parse(init.body));
      return Response.json({ code: 0, data: {} });
    }
    throw new Error('unexpected Feishu request');
  };
  try {
    const r = await records.handler({ headers: {}, requestContext: { http: { method: 'POST' } }, body: JSON.stringify({ token: 'test-token' }) });
    const result = JSON.parse(r.body);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(result.records.map((x) => x.category), ['🍲一日三餐', '💳收入']);
    const saved = await edit.handle({ method: 'POST', body: JSON.stringify({ token: 'test-token', id: 'recTest1', category: '🍲一日三餐' }) });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(bodies[0].fields['账单类目'], '🍝美食');
    assert.equal(JSON.parse(saved.body).record.category, '🍲一日三餐');
  } finally {
    global.fetch = originalFetch;
    settings.getSettings = originalSettings;
  }
});
