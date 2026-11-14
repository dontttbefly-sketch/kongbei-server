'use strict';
// 空杯记账 · 飞书「一键创建应用」（零依赖复刻官方 node-sdk 的 registerApp）
//
// 用户点一下 → 打开一个飞书链接 → 在飞书里点「确认」→ 应用自动建好、权限自动配好（包括多维表格），
// 凭证直接回到我们的服务器，用户全程不需要复制粘贴任何东西。
//
// 协议（RFC 8628 设备授权 + 飞书自己的确认页参数）：
//   1) POST https://accounts.feishu.cn/oauth/v1/app/registration  action=begin → device_code + verification_uri_complete
//   2) 在 verification_uri_complete 上追加 name/desc/addons/createOnly 等参数，给用户打开或转二维码
//   3) 轮询同一个端点 action=poll&device_code=…；用户在飞书点确认前返回 authorization_pending，确认后返回凭证
//
// 与官方 SDK 的差异：只发我们需要的权限（preset:false + scopes 全由我们声明），不叠智能体默认清单，
// 所以建出来的应用干干净净：只有多维表格和云空间两个权限。

const zlib = require('node:zlib');

const ACCOUNTS = 'https://accounts.feishu.cn';
const ENDPOINT = '/oauth/v1/app/registration';
const SDK_SOURCE = 'node-sdk/kongbei';

// 权限清单 → 确认页的 addons 参数：JSON → gzip → base64url（去掉 padding）
function encodeAddons(addons) {
  const json = JSON.stringify(addons);
  return zlib
    .gzipSync(Buffer.from(json, 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function requestRegistration(params, timeoutMs = 10_000) {
  const res = await fetch(`${ACCOUNTS}${ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// 第一步：拿到给用户打开的链接 + 用于轮询的 device_code
async function begin({ name, desc, scopes }) {
  const { status, data } = await requestRegistration({
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  });
  if (!data.verification_uri_complete || !data.device_code) {
    throw new Error(`飞书一键创建接口异常（HTTP ${status}）：${data.error_description || data.error || data.msg || '没有返回链接'}`);
  }

  const url = new URL(data.verification_uri_complete);
  url.searchParams.set('from', 'sdk');
  url.searchParams.set('source', SDK_SOURCE);
  url.searchParams.set('tp', 'sdk');
  if (name) url.searchParams.set('name', name);
  if (desc) url.searchParams.set('desc', desc);
  url.searchParams.set('addons', encodeAddons({ preset: false, scopes: { tenant: scopes } }));
  url.searchParams.set('createOnly', 'true'); // 只允许新建，避免用户误选已有应用覆盖配置

  return {
    url: url.toString(),
    deviceCode: data.device_code,
    intervalMs: (Number(data.interval) || 5) * 1000,
    expiresInMs: (Number(data.expires_in) || 600) * 1000,
  };
}

// 第二步：轮询。用户在飞书点确认前 → { pending: true }；确认后 → { appId, appSecret }
async function poll(deviceCode) {
  const { data } = await requestRegistration({ action: 'poll', device_code: deviceCode });
  if (data.client_id && data.client_secret) return { appId: data.client_id, appSecret: data.client_secret, userInfo: data.user_info || null };

  const err = String(data.error || data.code || '');
  if (err === 'authorization_pending' || err === 'slow_down') return { pending: true, slowDown: err === 'slow_down' };
  if (err === 'expired_token') return { expired: true };
  if (err === 'access_denied') return { denied: true };
  // 未知错误：不抛，交给上层决定（可能是飞书改了协议，或者网络回了个空）
  return { unknown: true, detail: data.error_description || err || '未知响应' };
}

module.exports = { begin, poll, encodeAddons, ACCOUNTS, ENDPOINT };
