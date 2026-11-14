'use strict';
// 专属记账地址：凭看板口令换地址；口令错 401；没配记账口令时给 null
const test = require('node:test');
const assert = require('node:assert');

process.env.API_TOKEN = 'view-token';
const { handle } = require('./shortcut.js');

const post = (body, headers = { host: 'app.example.com' }) => handle({ headers, method: 'POST', body: JSON.stringify(body) }).then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));

test('口令对：用请求的域名拼出带 key 的记账地址（特殊字符要转义）', async () => {
  process.env.ACCOUNTING_SECRET = 'a b&c';
  const r = await post({ token: 'view-token' });
  assert.equal(r.status, 200);
  assert.equal(r.url, 'https://app.example.com/api/accounting?key=a%20b%26c');
  const local = await post({ token: 'view-token' }, { 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' });
  assert.equal(local.url, 'http://localhost:3000/api/accounting?key=a%20b%26c');
});

test('全角口令也认（和读接口一样）；口令错 401', async () => {
  process.env.ACCOUNTING_SECRET = 's';
  assert.equal((await post({ token: 'ｖｉｅｗ-token' })).status, 200);
  assert.equal((await post({ token: 'nope' })).status, 401);
  assert.equal((await post({})).status, 401);
});

test('没配 ACCOUNTING_SECRET：地址是 null，看板据此提示去加环境变量', async () => {
  delete process.env.ACCOUNTING_SECRET;
  const r = await post({ token: 'view-token' });
  assert.equal(r.ok, true);
  assert.equal(r.url, null);
});
