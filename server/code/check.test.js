'use strict';
// 配置自检：格式检查、飞书错误码 → 改法、字段核对、部署前 / 部署后两轮（飞书和线上都用假的 fetch）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEnv, loadEnv, checkValues, explain, checkFields, checkLocal, checkUrl } = require('./check.js');

const ENV = {
  FEISHU_APP_ID: 'cli_a1b2c3',
  FEISHU_APP_SECRET: 'secret',
  BASE_TOKEN: 'BaseTok123',
  TABLE_ID: 'tblAbc123',
  API_TOKEN: 'view-token-1',
  ACCOUNTING_SECRET: 'a-long-accounting-secret',
};
const FIELDS = [
  { field_name: '备注', type: 1 },
  { field_name: '金额', type: 2 },
  { field_name: '记账日期', type: 5 },
  { field_name: '账单类目', type: 3, property: { options: ['🍲一日三餐', '🛍️生活日常', '✨值得体验', '👌投资蜕变', '💰投资蜕变·大额', '🚪外出', '🏠住房', '🏷️人情', '💳收入'].map((name) => ({ name })) } },
  { field_name: '复盘', type: 1 },
];
const levels = (rs) => rs.map((r) => r.level);

// 假飞书：按路径回包；over 里的同名路径覆盖默认
function fakeFeishu(over = {}) {
  const calls = [];
  const routes = {
    tenant_access_token: { code: 0, tenant_access_token: 't', expire: 7200 },
    tables: { code: 0, data: { items: [{ name: '记账数据库', table_id: 'tblAbc123' }] } },
    fields: { code: 0, data: { items: FIELDS } },
    search: { code: 0, data: { total: 3 } },
    records: { code: 1254045, msg: 'FieldNameNotFound' },
    ...over,
  };
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts.body });
    const last = new URL(url).pathname.split('/').pop(); // …/tenant_access_token/internal、…/tables、…/fields、…/search、…/records
    return { status: 200, json: async () => routes[last === 'internal' ? 'tenant_access_token' : last] };
  };
  return { fetchImpl, calls };
}

test('parseEnv：注释、export、引号、空值', () => {
  assert.deepEqual(parseEnv('# x\nexport A=1\nB="two words"\nC=\'3\'\nD=\n  E = 5 \n'), { A: '1', B: 'two words', C: '3', D: '', E: '5' });
});

test('loadEnv：进程里有的不覆盖，文件只补空缺，报告用到的文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-check-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, '.env'), 'A=from-root\nB=from-root\n');
  fs.writeFileSync(path.join(dir, 'server/.env'), 'B=from-server\nC=from-server\n');
  const env = { A: 'from-process' };
  assert.deepEqual(loadEnv(env, dir), ['.env', 'server/.env']);
  assert.deepEqual(env, { A: 'from-process', B: 'from-root', C: 'from-server' });
});

test('checkValues：缺变量、网址整段贴进来、用了模板本身、口令太短或相同', () => {
  assert.deepEqual(levels(checkValues(ENV)), ['ok']);
  assert.match(checkValues({ ...ENV, TABLE_ID: '' })[0].msg, /缺环境变量：TABLE_ID/);
  assert.match(checkValues({ ...ENV, BASE_TOKEN: 'https://x.feishu.cn/base/abc?table=tbl1' })[0].msg, /混进了网址/);
  assert.match(checkValues({ ...ENV, BASE_TOKEN: 'X1xxbHktMa0O6dsWbffcfnlXnid' })[0].msg, /模板本身/);
  assert.match(checkValues({ ...ENV, FEISHU_APP_ID: '123' })[0].msg, /cli_/);
  const weak = checkValues({ ...ENV, API_TOKEN: 'abc', ACCOUNTING_SECRET: 'abc' });
  assert.deepEqual(levels(weak), ['warn', 'warn', 'warn']);
});

test('explain：常见错误码给出具体改法；读和写的 91403 说法不同', () => {
  assert.match(explain(10014, 'app secret invalid'), /FEISHU_APP_SECRET/);
  assert.match(explain(91402), /\/wiki\//);
  assert.match(explain(91403), /添加文档应用/);
  assert.match(explain(91403, '', 'write'), /改成「可编辑」/);
  assert.match(explain(99991672, 'Access denied. One of the following scopes is required'), /bitable:app/);
  assert.match(explain(12345, 'odd'), /12345 odd/);
});

test('checkFields：缺字段、类型不对是 ✗；缺「复盘」、类目选项不全只是 !', () => {
  assert.deepEqual(levels(checkFields(FIELDS)), ['ok']);
  assert.deepEqual(levels(checkFields(FIELDS.filter((f) => f.field_name !== '金额'))), ['fail']);
  assert.deepEqual(levels(checkFields(FIELDS.map((f) => (f.field_name === '记账日期' ? { ...f, type: 1001 } : f)))), ['fail']);
  const lite = FIELDS.filter((f) => f.field_name !== '复盘').map((f) => (f.field_name === '账单类目' ? { ...f, property: { options: [{ name: '🏷️人情' }] } } : f));
  assert.deepEqual(levels(checkFields(lite)), ['ok', 'warn', 'warn']);
});

test('checkFields：改过名的选项仍识别为原分类', () => {
  const renamed = FIELDS.map((f) => f.field_name === '账单类目' ? { ...f, property: { options: f.property.options.map((o) => o.name === '🍲一日三餐' ? { ...o, name: '🍜餐饮' } : o) } } : f);
  assert.deepEqual(levels(checkFields(renamed, { names: { '🍲一日三餐': '🍜餐饮' } })), ['ok']);
});

test('checkLocal：全通过；试写用不存在的字段，什么也写不进去', async () => {
  const { fetchImpl, calls } = fakeFeishu();
  const rs = await checkLocal(ENV, fetchImpl);
  assert.deepEqual(levels(rs), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  const write = calls.find((c) => /\/records$/.test(c.url));
  assert.deepEqual(JSON.parse(write.body), { fields: { __kb_check__: 1 } });
});

test('checkLocal：凭证错就停；应用没加进表格；只读；TABLE_ID 不在表格里时列出有哪些表', async () => {
  let rs = await checkLocal(ENV, fakeFeishu({ tenant_access_token: { code: 10014, msg: 'app secret invalid' } }).fetchImpl);
  assert.deepEqual(levels(rs), ['ok', 'fail']);

  rs = await checkLocal(ENV, fakeFeishu({ tables: { code: 91403, msg: 'Forbidden' } }).fetchImpl);
  assert.match(rs.at(-1).fix, /添加文档应用/);

  rs = await checkLocal(ENV, fakeFeishu({ records: { code: 91403, msg: 'Forbidden' } }).fetchImpl);
  assert.equal(rs.at(-1).level, 'fail');
  assert.match(rs.at(-1).fix, /可编辑/);

  rs = await checkLocal({ ...ENV, TABLE_ID: 'tblOther' }, fakeFeishu().fetchImpl);
  assert.match(rs.at(-1).fix, /记账数据库=tblAbc123/);
});

// 假线上：按路径回 [status, body]；body 是字符串就原样当文本
function fakeSite(over = {}) {
  const routes = {
    '/': [200, '<html><head><title>空杯记账</title></head></html>'],
    '/api/records': [200, { ok: true, count: 0 }],
    '/api/accounting': [200, { ok: true, dryRun: true }],
    '/api/push': [200, { ok: true, publicKey: 'pk', ready: true }],
    ...over,
  };
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push({ url, opts });
    const [status, body, finalUrl = url] = routes[new URL(url).pathname]; // 第三项：跟随跳转后落到的地址
    return { status, url: finalUrl, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { fetchImpl, sent };
}

test('checkUrl：全通过；试记带 dryRun，口令走请求头不进网址；vercel.app 提醒国内打不开', async () => {
  const { fetchImpl, sent } = fakeSite();
  const rs = await checkUrl('kb-demo.vercel.app', ENV, fetchImpl, new Date('2026-10-07T20:00:00Z'));
  assert.deepEqual(levels(rs), ['ok', 'ok', 'ok', 'ok', 'warn']);
  const rec = sent.find((s) => s.url.endsWith('/api/records'));
  assert.deepEqual(JSON.parse(rec.opts.body), { token: ENV.API_TOKEN, from: '2026-10-08' }); // 按北京时间算今天
  const acc = sent.find((s) => s.url.endsWith('/api/accounting'));
  assert.equal(JSON.parse(acc.opts.body).dryRun, true);
  assert.equal(acc.opts.headers['X-Accounting-Secret'], ENV.ACCOUNTING_SECRET);
  assert.ok(!sent.some((s) => s.url.includes(ENV.ACCOUNTING_SECRET)));
});

test('checkUrl：口令对不上、Vercel 上缺环境变量、飞书报错、提醒没配', async () => {
  const { fetchImpl } = fakeSite({
    '/api/records': [502, { ok: false, error: 'feishu_error', detail: 'feishu search failed: code=91403 msg=Forbidden' }],
    '/api/accounting': [401, { ok: false, error: 'unauthorized' }],
    '/api/push': [200, { ok: true, publicKey: null, ready: false }],
  });
  const rs = await checkUrl('https://kb.example.com', ENV, fetchImpl);
  assert.deepEqual(levels(rs), ['ok', 'fail', 'fail', 'warn']);
  assert.match(rs[1].fix, /添加文档应用/);
  assert.match(rs[2].fix, /ACCOUNTING_SECRET/);
  assert.match(rs[3].msg, /VAPID/);

  // 缺 API_TOKEN 时读接口直接崩（Vercel 回纯文本 500）；缺 ACCOUNTING_SECRET 时记账接口回 JSON 的 500
  const crashed = await checkUrl('https://kb.example.com', ENV, fakeSite({
    '/api/records': [500, 'A server error has occurred'],
    '/api/accounting': [500, { ok: false, error: 'internal_error', message: '服务内部错误' }],
  }).fetchImpl);
  assert.match(crashed[1].fix, /缺环境变量/);
  assert.match(crashed[2].fix, /缺环境变量/);

  const other = await checkUrl('https://kb.example.com', ENV, fakeSite({ '/': [200, '<title>别的网站</title>'] }).fetchImpl);
  assert.deepEqual(levels(other), ['fail']);
  assert.match(other[0].fix, /不是空杯记账/);
});

test('checkUrl：带随机串的部署地址跳到 Vercel 登录页（状态码 200），提示换成正式地址', async () => {
  const login = 'https://vercel.com/login?next=%2Fsso-api';
  const rs = await checkUrl('https://kb-abc123-someone.vercel.app', ENV, fakeSite({ '/': [200, '<title>Login – Vercel</title>', login] }).fetchImpl);
  assert.deepEqual(levels(rs), ['fail']);
  assert.match(rs[0].fix, /Aliased/);
});
