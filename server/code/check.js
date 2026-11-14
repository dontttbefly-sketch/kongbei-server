#!/usr/bin/env node
'use strict';
// 空杯记账 · 配置自检：部署前查飞书那一头配对没有，部署后查线上通不通。只读，不写账，不打印口令。
//
//   node server/code/check.js                         部署前：环境变量、飞书凭证、表格能不能读写、字段对不对
//   node server/code/check.js --url https://你的看板    部署后：再查看板能打开、能读账、记账口令对得上、备注提醒配没配
//
// 环境变量先从当前进程读，没有的再依次从仓库根目录的 .env、.env.local、server/.env 补（这几个文件都不进仓库）。
// 部署前那一轮占 4 次飞书接口额度：列表格、列字段、读一笔、试写一次。试写用一个不存在的字段，
// 有编辑权限时飞书回「字段不存在」、没有时回「无权限」，两种情况都写不进任何东西。
// 有 ✗ 时退出码是 1；每个 ✗ 下面一行写着怎么改。

const fs = require('fs');
const path = require('path');
const { CATEGORY_OPTIONS } = require('./accounting.js');

const FEISHU = 'https://open.feishu.cn/open-apis';
const ROOT = path.join(__dirname, '../..');
const ENV_FILES = ['.env', '.env.local', 'server/.env'];
const REQUIRED_ENV = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'BASE_TOKEN', 'TABLE_ID', 'API_TOKEN', 'ACCOUNTING_SECRET'];
const TEMPLATE_BASE = 'X1xxbHktMa0O6dsWbffcfnlXnid'; // 公开模板本身：要先「创建副本」，不能直接用
// 字段类型：1 文本、2 数字、3 单选、5 日期（飞书多维表格的 type 编号）
const FIELDS = [
  { name: '备注', type: 1, label: '文本' },
  { name: '金额', type: 2, label: '数字' },
  { name: '记账日期', type: 5, label: '日期' },
  { name: '账单类目', type: 3, label: '单选' },
  { name: '复盘', type: 1, label: '文本', optional: true },
];

const ok = (msg) => ({ level: 'ok', msg });
const warn = (msg, fix) => ({ level: 'warn', msg, fix });
const fail = (msg, fix) => ({ level: 'fail', msg, fix });

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// 进程里已有的优先；文件里的只补空缺。返回用到了哪些文件
function loadEnv(env = process.env, root = ROOT, files = ENV_FILES) {
  const used = [];
  for (const f of files) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    let hit = false;
    for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(p, 'utf8')))) {
      if (!env[k] && v) (env[k] = v), (hit = true);
    }
    if (hit) used.push(f);
  }
  return used;
}

// 只看格式，不联网
function checkValues(env) {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length) {
    return [fail(`缺环境变量：${missing.join('、')}`, '照仓库根目录的 .env.example 填进 .env（每项怎么取见 AGENTS.md）')];
  }
  const out = [];
  if (!/^cli_[A-Za-z0-9]+$/.test(env.FEISHU_APP_ID)) out.push(fail('FEISHU_APP_ID 格式不对（应以 cli_ 开头）', '到飞书开发者后台「凭证与基础信息」复制 App ID'));
  if (/[/?=&\s]/.test(env.BASE_TOKEN)) out.push(fail('BASE_TOKEN 里混进了网址的其它部分', '只要表格网址里 /base/ 后面、? 前面那一段'));
  else if (env.BASE_TOKEN === TEMPLATE_BASE) out.push(fail('BASE_TOKEN 是公开模板本身，不是你的副本', '打开模板，右上角「…」→「创建副本」，用副本网址里的那一段'));
  if (!/^tbl[A-Za-z0-9]+$/.test(env.TABLE_ID)) out.push(fail('TABLE_ID 格式不对（应以 tbl 开头）', '只要表格网址里 table= 后面、& 前面那一段'));
  if (env.API_TOKEN === env.ACCOUNTING_SECRET) out.push(warn('看板口令和记账口令一样', '记账口令会拼进快捷指令里的地址，最好两个分开'));
  if (env.API_TOKEN.length < 8) out.push(warn('看板口令（API_TOKEN）不到 8 位，容易被猜到', '换一个长一点的；它只要在手机上输一次'));
  if (env.ACCOUNTING_SECRET.length < 16) out.push(warn('记账口令（ACCOUNTING_SECRET）不到 16 位', '用随机生成的长串，不用记，看板会帮你复制给快捷指令'));
  if (!out.length) out.push(ok('6 个环境变量都填了，格式对'));
  return out;
}

// 飞书错误码 → 怎么改
function explain(code, msg = '', step = '') {
  if (code === 10003 || code === 10014) return 'FEISHU_APP_ID / FEISHU_APP_SECRET 不对：到飞书开发者后台「凭证与基础信息」重新复制';
  if (code === 91402) return 'BASE_TOKEN 不对：取表格网址里 /base/ 后面、? 前面那一段；表放在知识库里（网址是 /wiki/）的话，先挪到云空间再取';
  if (code === 1254041) return 'TABLE_ID 不对：取表格网址里 table= 后面、& 前面那一段';
  if (code === 91403) {
    return step === 'write'
      ? '应用只能看、不能改：表格右上角「…」→「更多」→「文档应用」，把这个应用的权限改成「可编辑」'
      : '应用还没加进这张表格：表格右上角「…」→「更多」→「添加文档应用」，搜应用名，权限给「可编辑」';
  }
  if (code === 99991672 || /scope/i.test(msg)) return '应用没开通多维表格权限或还没发布：开发者后台「权限管理」开通「查看、评论、编辑和管理多维表格」(bitable:app)，再到「版本管理与发布」发一个版本';
  if (code === 99991400 || code === 99991403) return '飞书接口额度用完了或被限流（免费版每月 1 万次），过一会儿或下个月再试';
  return `飞书返回 ${code} ${msg}，可在 https://open.feishu.cn/search?q=${code} 查这个错误码`;
}

function checkFields(items, settings = {}) {
  const out = [];
  const byName = new Map(items.map((f) => [f.field_name, f]));
  for (const want of FIELDS) {
    const f = byName.get(want.name);
    if (!f) {
      if (want.optional) out.push(warn(`没有「${want.name}」字段（可选）`, `想要的话加一个${want.label}字段，名字叫「${want.name}」`));
      else out.push(fail(`缺字段「${want.name}」`, `在记账表里加一个${want.label}字段，名字一字不差叫「${want.name}」（或者直接用模板创建副本）`));
    } else if (f.type !== want.type) {
      out.push(fail(`字段「${want.name}」类型不对（要${want.label}）`, `把「${want.name}」的字段类型改成${want.label}`));
    }
  }
  const cat = byName.get('账单类目');
  if (cat && cat.type === 3) {
    const { canonicalCategory } = require('./category-sync.js');
    const have = new Set((cat.property?.options || []).map((o) => canonicalCategory(o.name, settings.names, settings.aliases)));
    const lack = CATEGORY_OPTIONS.filter((o) => !have.has(o));
    if (lack.length) out.push(warn(`「账单类目」少了选项：${lack.join('、')}`, '记账时飞书会自动补上；想整齐的话照 docs/自己部署.md 第 1 步把 9 个选项加齐'));
  }
  if (!out.some((r) => r.level === 'fail')) out.unshift(ok('记账表字段齐全'));
  return out;
}

async function feishu(fetchImpl, p, { method = 'GET', body, token } = {}) {
  const res = await fetchImpl(FEISHU + p, {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}` }));
}

// 部署前：一步不过就停（后面的步骤都依赖前面的）
async function checkLocal(env, fetchImpl = fetch) {
  const out = checkValues(env);
  if (out.some((r) => r.level === 'fail')) return out;
  const base = `/bitable/v1/apps/${env.BASE_TOKEN}/tables`;

  const t = await feishu(fetchImpl, '/auth/v3/tenant_access_token/internal', { method: 'POST', body: { app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET } });
  if (t.code !== 0) return [...out, fail('飞书应用凭证不对', explain(t.code, t.msg))];
  out.push(ok('飞书应用凭证对'));
  const token = t.tenant_access_token;

  const tables = await feishu(fetchImpl, `${base}?page_size=100`, { token });
  if (tables.code !== 0) return [...out, fail('读不了这张表格', explain(tables.code, tables.msg))];
  const items = tables.data?.items || [];
  const table = items.find((x) => x.table_id === env.TABLE_ID);
  if (!table) {
    const list = items.map((x) => `${x.name}=${x.table_id}`).join('、');
    return [...out, fail('表格里没有这个 TABLE_ID', `${explain(1254041)}。这个表格里有：${list || '（没有数据表）'}`)];
  }
  out.push(ok(`能读这张表格，记账表是「${table.name}」`));

  const fields = await feishu(fetchImpl, `${base}/${env.TABLE_ID}/fields?page_size=100`, { token });
  if (fields.code !== 0) return [...out, fail('读不了字段', explain(fields.code, fields.msg))];
  let settings = {};
  const settingsTable = items.find((x) => x.name === '看板设置');
  if (settingsTable) {
    const rows = await feishu(fetchImpl, `${base}/${settingsTable.table_id}/records/search?page_size=100`, { method: 'POST', body: { field_names: ['键', '值'] }, token });
    if (rows.code === 0) {
      const { cellText } = require('./feishu.js');
      const row = (rows.data?.items || []).find((x) => cellText(x.fields?.['键']) === 'settings');
      try { if (row) settings = JSON.parse(cellText(row.fields?.['值'])); } catch {}
    }
  }
  out.push(...checkFields(fields.data?.items || [], settings));
  if (out.some((r) => r.level === 'fail')) return out;

  const one = await feishu(fetchImpl, `${base}/${env.TABLE_ID}/records/search?page_size=1`, { method: 'POST', body: {}, token });
  if (one.code !== 0) return [...out, fail('读不了账', explain(one.code, one.msg))];
  out.push(ok(`能读账，表里现在 ${one.data?.total ?? 0} 笔`));

  const probe = await feishu(fetchImpl, `${base}/${env.TABLE_ID}/records`, { method: 'POST', body: { fields: { __kb_check__: 1 } }, token });
  if (probe.code === 1254045) out.push(ok('应用能写这张表格（记账、改账、自动建「看板设置」等表都靠它）'));
  else if (probe.code === 91403) out.push(fail('应用不能写这张表格', explain(91403, '', 'write')));
  else out.push(warn(`没法确认能不能写（飞书返回 ${probe.code} ${probe.msg}）`, '部署后用快捷指令记一笔试试'));
  return out;
}

async function http(fetchImpl, url, { method = 'GET', body, headers = {} } = {}) {
  try {
    const res = await fetchImpl(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json, finalUrl: res.url || url };
  } catch (e) {
    return { status: 0, text: String(e.cause?.code || e.message), json: null, finalUrl: url };
  }
}

// ── 线上版（SaaS）自检：node server/code/check.js --saas ──────
async function redisCmd(fetchImpl, url, token, args) {
  const r = await http(fetchImpl, url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  if (r.status === 0) return { err: `连不上（${r.text}）` };
  if (r.status >= 300) return { err: `HTTP ${r.status}` };
  if (r.json?.error) return { err: r.json.error };
  return { result: r.json?.result };
}

async function checkSaas(env, fetchImpl = fetch) {
  const out = [];

  if (env.SAAS_MODE !== '1') out.push(warn('SAAS_MODE 不是 1', '线上版要设 SAAS_MODE=1；不设就是按开源版跑（用户看到的是口令输入框，不是绑定引导）'));
  else out.push(ok('SAAS_MODE=1，线上版模式已开'));

  if (!env.SAAS_SECRET || env.SAAS_SECRET.length < 16) out.push(fail('SAAS_SECRET 没配或太短', '凭证加密主密钥，生成一个：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'));
  else out.push(ok('SAAS_SECRET 已配置（凭证加密主密钥）'));

  if (!env.SAAS_ADMIN_TOKEN || env.SAAS_ADMIN_TOKEN.length < 12) out.push(warn('SAAS_ADMIN_TOKEN 没配或太短（管理接口要用）', '取一个 12 位以上的随机串；生成激活码 / 查用户都用它'));
  else out.push(ok('SAAS_ADMIN_TOKEN 已配置（运营管理口令）'));

  const trial = String(env.SAAS_TRIAL_DAYS ?? '').trim() === '' ? 7 : Number(env.SAAS_TRIAL_DAYS);
  out.push(ok(`新用户绑定即送试用：${Number.isFinite(trial) && trial > 0 ? `${trial} 天` : '无（绑定后需激活才能记账）'}`));

  if (!env.CRON_SECRET) out.push(warn('CRON_SECRET 没配（到期提醒的定时入口无鉴权）', '取一个随机串配上；不配的话别人也能触发 /api/saas-cron'));
  else out.push(ok('CRON_SECRET 已配置（定时提醒只认 Vercel Cron）'));

  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) {
    out.push(fail('缺 Upstash Redis 配置（租户库）', '去 console.upstash.com 免费建一个库（Region 选香港或新加坡，和函数同区），把 REST 区的 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 填进环境变量；Vercel 里装 Upstash 集成会要求绑卡按量付费，不用走那条'));
    return out;
  }

  const key = `kb:check:${Date.now()}`;
  const set = await redisCmd(fetchImpl, url, token, ['SET', key, '1']);
  if (set.err) return [...out, fail('连不上 Upstash Redis', `检查 URL / TOKEN 是否复制完整、Region 是否可用（${set.err}）`)];
  await redisCmd(fetchImpl, url, token, ['DEL', key]);
  out.push(ok('Upstash Redis 通，租户库可读写'));

  const scan = await redisCmd(fetchImpl, url, token, ['SCAN', '0', 'MATCH', 't:*', 'COUNT', 100]);
  if (!scan.err) out.push(ok(`租户库里现有 ${(scan.result && scan.result[1] ? scan.result[1].length : 0)} 个用户（刚部署应该是 0）`));

  return out;
}

// 带随机串的部署地址有 Vercel 的登录保护：会跳到 vercel.com/sso-api → 登录页，状态码还是 200
const toVercelLogin = (r) => /(^|\.)vercel\.com$/.test(new URL(r.finalUrl).hostname);
const LOGIN_FIX = '这是带随机串的部署地址，有 Vercel 的登录保护：用部署输出里 Aliased 后面的 https://<项目名>.vercel.app，或者自己的域名';

// 线上接口出错时怎么改（200 以外）
function explainHttp(r, secretName) {
  if (r.status === 0) return `连不上（${r.text}）：地址对不对？在国内的话，vercel.app 不开梯子打不开`;
  if (toVercelLogin(r)) return LOGIN_FIX;
  if (r.status === 401 && r.json) return `口令和 Vercel 上的 ${secretName} 对不上：改完环境变量要重新部署一次（vercel deploy --prod）`;
  if (r.status === 401 || r.status === 403) return LOGIN_FIX;
  if (r.status === 502 && r.json?.detail) {
    const m = /code=(-?\d+) msg=(.*)$/.exec(r.json.detail) || /错误：(-?\d+) (.*)$/.exec(r.json.detail);
    return m ? explain(Number(m[1]), m[2]) : r.json.detail;
  }
  if (r.status === 500) return 'Vercel 上缺环境变量，或者加完没重新部署：vercel env ls production 看 6 个是不是都在，再 vercel deploy --prod --yes';
  return `HTTP ${r.status} ${(r.json && (r.json.message || r.json.error)) || r.text.slice(0, 120)}`;
}

// 部署后：每一项单独查，互不影响
async function checkUrl(rawUrl, env, fetchImpl = fetch, today = new Date()) {
  const out = [];
  let u;
  try {
    u = new URL(/^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return [fail(`地址不对：${rawUrl}`, '形如 https://xxx.vercel.app 或 https://你的域名')];
  }
  const site = u.origin;

  const page = await http(fetchImpl, `${site}/`);
  if (page.status === 200 && page.text.includes('<title>空杯记账')) out.push(ok(`看板能打开：${site}`));
  else return [fail(`看板打不开：${site}`, page.status === 200 && !toVercelLogin(page) ? '这个地址上不是空杯记账' : explainHttp(page))];

  const day = new Date(today.getTime() + 8 * 3600e3).toISOString().slice(0, 10); // 只要今天的账，回包小
  const rec = await http(fetchImpl, `${site}/api/records`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: env.API_TOKEN, from: day }) });
  if (rec.status === 200 && rec.json?.ok) out.push(ok('线上能读账（看板口令对，飞书通）'));
  else out.push(fail('线上读不了账', explainHttp(rec, 'API_TOKEN')));

  const acc = await http(fetchImpl, `${site}/api/accounting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Accounting-Secret': env.ACCOUNTING_SECRET },
    body: JSON.stringify({ amount: -1, class: '其他', event: '配置自检', dryRun: true }),
  });
  if (acc.status === 200 && acc.json?.ok) out.push(ok('记账接口通，记账口令对（试记不写表）'));
  else out.push(fail('记账接口不通', explainHttp(acc, 'ACCOUNTING_SECRET')));

  const push = await http(fetchImpl, `${site}/api/push`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: env.API_TOKEN, op: 'config' }) });
  if (push.json?.ready) out.push(ok('备注提醒配好了'));
  else if (push.json?.ok) {
    const lack = push.json.publicKey ? 'Upstash QStash 集成' : '推送密钥 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT（还有 QStash，没装的话）';
    out.push(warn(`备注提醒没配（可选，不配也能用）：缺${lack}`, '要的话照 AGENTS.md「可选：备注提醒」配'));
  }

  if (u.hostname.endsWith('.vercel.app')) out.push(warn('用的是 vercel.app 地址', '国内打不开，要绑自己的域名（docs/自己部署.md 第 3、4 步）'));
  return out;
}

function print(results) {
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  for (const r of results) {
    console.log(`  ${mark[r.level]} ${r.msg}`);
    if (r.fix) console.log(`    → ${r.fix}`);
  }
}

async function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('用法：node server/code/check.js [--url https://你的看板地址] [--saas]');
    console.log('  （不带参数）查飞书那一头；--url 查线上；--saas 查线上版配置（Redis、加密密钥、管理口令）');
    return 0;
  }

  // 线上版自检：只查 SaaS 相关配置 + Redis 连通，不查飞书（用户各自带自己的）。运营方的密钥放在 server/.env.saas.local
  if (argv.includes('--saas')) {
    const usedSaas = loadEnv(process.env, ROOT, [...ENV_FILES, 'server/.env.saas.local']);
    console.log(`空杯记账 · 线上版配置自检（环境变量来自：${usedSaas.length ? usedSaas.join('、') : '当前进程'}）\n`);
    console.log('线上版');
    const res = await checkSaas(process.env);
    print(res);
    const failed = res.filter((r) => r.level === 'fail').length;
    console.log(failed ? `\n${failed} 项没通过，照 → 后面改完再跑一次。` : '\n线上版配置没问题，可以部署了。');
    return failed ? 1 : 0;
  }

  const i = argv.findIndex((a) => a === '--url' || a.startsWith('--url='));
  const url = i < 0 ? '' : argv[i].includes('=') ? argv[i].slice(6) : argv[i + 1] || '';
  if (i >= 0 && !url) {
    console.log('--url 后面要跟看板地址');
    return 1;
  }

  const used = loadEnv();
  console.log(`空杯记账 · 配置自检（环境变量来自：${used.length ? used.join('、') : '当前进程'}）\n`);
  console.log('飞书');
  const local = await checkLocal(process.env);
  print(local);
  let all = local;
  if (url && !local.some((r) => r.level === 'fail' && /缺环境变量/.test(r.msg))) {
    console.log('\n线上');
    const remote = await checkUrl(url, process.env);
    print(remote);
    all = [...local, ...remote];
  }
  const failed = all.filter((r) => r.level === 'fail').length;
  console.log(failed ? `\n${failed} 项没通过，照 → 后面改完再跑一次。` : url ? '\n全部通过。' : '\n飞书这头没问题，可以部署了；部署完加 --url 再查一次线上。');
  return failed ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => (process.exitCode = code));

module.exports = { parseEnv, loadEnv, checkValues, explain, checkFields, checkLocal, checkUrl, explainHttp };
