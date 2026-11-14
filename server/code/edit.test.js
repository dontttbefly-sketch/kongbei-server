'use strict';
// 改一笔：不联网的部分（校验、字段、口令）
const test = require('node:test');
const assert = require('node:assert');

process.env.API_TOKEN = 'kb-test';
const { handle, buildPatch, fieldsOf } = require('./edit.js');

const post = (body, method = 'POST') => handle({ method, body: typeof body === 'string' ? body : JSON.stringify(body) }).then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));

test('只收带了的字段；分类不带 emoji 也认；收入翻成正数', () => {
  assert.deepEqual(buildPatch({ id: 'recAbc123', note: ' 午饭 ' }), { note: '午饭' });
  assert.deepEqual(buildPatch({ id: 'recAbc123', amount: '-28.456', category: '一日三餐' }), { category: '🍲一日三餐', amount: -28.46 });
  assert.deepEqual(buildPatch({ id: 'recAbc123', amount: -5000, category: '💳收入' }), { category: '💳收入', amount: 5000 });
  assert.deepEqual(buildPatch({ id: 'recAbc123', amount: 12, category: '🚪外出' }), { category: '🚪外出', amount: 12 }); // 退款：正数原样
});

test('不合法的直接 400：id、金额 0 / 非数字、空分类、不在列表的分类、什么都没带', () => {
  assert.throws(() => buildPatch({ id: '../x', note: 'a' }), /id/);
  assert.throws(() => buildPatch({ id: 'recAbc123', amount: 0 }), /金额/);
  assert.throws(() => buildPatch({ id: 'recAbc123', amount: 'abc' }), /金额/);
  assert.throws(() => buildPatch({ id: 'recAbc123', amount: true }), /金额/);
  assert.throws(() => buildPatch({ id: 'recAbc123', category: '' }), /分类不能为空/);
  assert.throws(() => buildPatch({ id: 'recAbc123', category: '火锅' }), /不在允许列表/);
  assert.throws(() => buildPatch({ id: 'recAbc123' }), /至少带一个/);
});

test('改日期：毫秒数，不收 2000 年以前、明天以后、不是数字的', () => {
  const t = Date.UTC(2026, 9, 5, 4, 30);
  assert.deepEqual(buildPatch({ id: 'recAbc123', time: t }), { time: t });
  assert.deepEqual(fieldsOf({ time: t }), { 记账日期: t });
  assert.throws(() => buildPatch({ id: 'recAbc123', time: Date.UTC(1999, 0, 1) }), /日期/);
  assert.throws(() => buildPatch({ id: 'recAbc123', time: Date.now() + 3 * 864e5 }), /日期/);
  assert.throws(() => buildPatch({ id: 'recAbc123', time: '2026-10-05' }), /日期/);
});

test('删一笔：id 不对 400；dryRun 不碰飞书', async () => {
  assert.equal((await post({ token: 'kb-test', id: '../x', delete: true })).status, 400);
  const r = await post({ token: 'kb-test', id: 'recAbc123', delete: true, dryRun: true });
  assert.equal(r.status, 200);
  assert.equal(r.deleted, false);
});

test('飞书字段：备注清空写 null，其它原样', () => {
  assert.deepEqual(fieldsOf({ amount: -3, category: '🚪外出', note: '' }), { 金额: -3, 账单类目: '🚪外出', 备注: null });
  assert.deepEqual(fieldsOf({ note: '地铁' }), { 备注: '地铁' });
});

test('口令不对 401；非 POST 405；分类不对 400（不碰飞书）', async () => {
  assert.equal((await post({ id: 'recAbc123', note: 'a' }, 'GET')).status, 405);
  assert.equal((await post({ token: 'kb-test', id: 'recAbc123', category: '火锅' })).status, 400);
  assert.equal((await post('不是 JSON')).status, 400);
  const t0 = Date.now();
  const bad = await post({ token: 'wrong', id: 'recAbc123', note: 'a' });
  assert.equal(bad.status, 401);
  assert.ok(Date.now() - t0 >= 2900, '口令错误要延迟响应');
});
