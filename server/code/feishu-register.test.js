'use strict';
// 一键创建协议层测试：addons 编码 / 确认页参数拼装（不碰网络）
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { encodeAddons } = require('./feishu-register.js');

test('encodeAddons：gzip + base64url，解开后与原文一致', () => {
  const addons = { preset: false, scopes: { tenant: ['bitable:app', 'drive:drive'] } };
  const enc = encodeAddons(addons);
  assert.ok(!/[+/=]/.test(enc), 'base64url 不应含 + / =');
  const json = zlib.gunzipSync(Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toString('utf8');
  assert.deepStrictEqual(JSON.parse(json), addons);
});

test('encodeAddons：内容变化时编码也变化（没写死）', () => {
  const a = encodeAddons({ preset: false, scopes: { tenant: ['bitable:app'] } });
  const b = encodeAddons({ preset: false, scopes: { tenant: ['drive:drive'] } });
  assert.notStrictEqual(a, b);
});
