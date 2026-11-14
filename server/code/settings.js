'use strict';
// 空杯记账 · 看板设置（2026-10-07）：哪些分类单独列出、每个分类「得到了什么」、哪种钱放哪。存在飞书里自动建的「看板设置」表（键 = settings，值 = JSON）。
// 默认值在 settings-defaults.json（看板也读这一份）。提醒的问法会用到「得到了什么」，所以放在服务器上，换设备也一样
//
// POST /api/settings   Content-Type: text/plain
//   {"token"}                         → {"ok", "settings": {...}, "saved": 飞书里有没有存过}
//   {"token", "settings": {...}}      → 存下（只收认得的分类，「得到了」每条最多 12 个字，「放」「别放」每段最多 200 字，改的名字最多 8 个字）

const { safeEqual } = require('./index.js');
const { findTable, search, call, tables, cellText } = require('./feishu.js');
const { configOf, cacheKey } = require('./tenant.js');
const { withTenant } = require('./saas.js');
const DEFAULTS = require('./settings-defaults.json');

const TABLE = '看板设置';
const FIELDS = [
  { field_name: '键', type: 1 },
  { field_name: '值', type: 1 },
  { field_name: '更新时间', type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
];
const { CATEGORY_OPTIONS, RENAMED_CATEGORIES } = require('./accounting.js');
const CATEGORIES = CATEGORY_OPTIONS.filter((c) => c !== '💳收入'); // 和记账接口同一份，换类目只改那里

// 类目改过名：存着的设置里旧名字的键挪到新名字下（新名字已经有了就不动）
function renameKeys(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out = { ...o };
  for (const [old, now] of Object.entries(RENAMED_CATEGORIES)) {
    if (old in out) {
      if (!(now in out)) out[now] = out[old];
      delete out[old];
    }
  }
  return out;
}
const MAX_GAIN = 12;
const MAX_RULE = 200;
const MAX_NAME = 8; // 改的名字最多 8 个字（不算前面的 emoji）

// 分类改名：键为稳定的内部分类标识，值为用户设置的「emoji + 名字」。
// 开头一个 emoji 可有可无（没有就沿用原来的），名字去掉多余空格、最多 MAX_NAME 个字；空的、和原名一样的不存
const EMOJI_HEAD = /^(\p{Extended_Pictographic}\uFE0F?)?\s*([\s\S]*)$/u;
function cleanName(v) {
  if (typeof v !== 'string') return '';
  const [, emoji = '', rest] = EMOJI_HEAD.exec(v.trim());
  const name = Array.from(rest.replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME).join('').trim();
  return name ? `${emoji}${name}` : '';
}
// 比较名字用：去掉开头的 emoji 和所有空白（「🎮 娱 乐」和「娱乐」算同一个）
const plainName = (v) => EMOJI_HEAD.exec(String(v).trim())[2].replace(/\s+/g, '');
const AUTH_FAIL_DELAY_MS = 3000;

// 只留认得的；缺的用默认补上
// 设置的版本（2026-10-18 加的 v）。v 不到 2 的旧设置：三餐、日常的「得到了什么」还是旧默认值「日常」的，换成新默认值「生活」——
// 「日常」成了主数字下面那一部分的名字（日常 ¥1,969 · 住房 ¥3,387），同一屏两个「日常」说的不是一笔钱。
// 设置是整份存的，光改默认值管不到已经存过的；存过 v=2 以后用户自己再改回「日常」就照存
const VERSION = 2;
const OLD_GAIN_DEFAULTS = { '🍲一日三餐': ['日常'], '🛍️生活日常': ['日常'] }; // 英文界面存的时候默认值会换回中文，所以只有中文的

function clean(s) {
  const raw = s && typeof s === 'object' ? s : {};
  const legacy = !(Number(raw.v) >= VERSION);
  const src = { ...raw, gains: renameKeys(raw.gains), rules: renameKeys(raw.rules), budgets: renameKeys(raw.budgets), yearBudgets: renameKeys(raw.yearBudgets), names: renameKeys(raw.names) };
  if (Array.isArray(raw.separate)) src.separate = raw.separate.map((c) => RENAMED_CATEGORIES[c] ?? c);
  const list = Array.isArray(src.separate) ? src.separate : DEFAULTS.separate;
  const separate = CATEGORIES.filter((c) => list.includes(c)); // 一律按分类的固定顺序
  const gains = {};
  const g = src.gains && typeof src.gains === 'object' ? src.gains : DEFAULTS.gains;
  for (const c of CATEGORIES) {
    let v = typeof g[c] === 'string' ? g[c].trim().replace(/^得到了/, '').slice(0, MAX_GAIN) : '';
    if (legacy && OLD_GAIN_DEFAULTS[c]?.includes(v)) v = DEFAULTS.gains[c];
    if (v) gains[c] = v;
  }
  // 哪种钱放哪（2026-10-07）：每类「放」「别放」各一段话，没存过就用默认
  const rules = {};
  const r = src.rules && typeof src.rules === 'object' ? src.rules : DEFAULTS.rules;
  for (const c of CATEGORIES) {
    const one = {};
    for (const k of ['put', 'avoid']) {
      const v = typeof r[c]?.[k] === 'string' ? r[c][k].replace(/\s+/g, ' ').trim().slice(0, MAX_RULE) : '';
      if (v) one[k] = v;
    }
    if (one.put || one.avoid) rules[c] = one;
  }
  // 每月额度（2026-10-07）：每类一个正数、最多一千万，不填就不管
  const budgets = {};
  const b = src.budgets && typeof src.budgets === 'object' ? src.budgets : {};
  for (const c of CATEGORIES) {
    const n = Number(b[c]);
    if (Number.isFinite(n) && n > 0 && n <= 1e7) budgets[c] = Math.round(n * 100) / 100;
  }
  // 按年的额度（2026-10-07，大件一阵一阵花，每月额度管不住）：每类一个正数；额度年从 yearStart 月 1 号算起（1–12，默认 1 = 自然年）
  const yearBudgets = {};
  const yb = src.yearBudgets && typeof src.yearBudgets === 'object' ? src.yearBudgets : {};
  for (const c of CATEGORIES) {
    const n = Number(yb[c]);
    if (Number.isFinite(n) && n > 0 && n <= 1e8) yearBudgets[c] = Math.round(n * 100) / 100;
  }
  const ys = Number(src.yearStart);
  const yearStart = Number.isInteger(ys) && ys >= 1 && ys <= 12 ? ys : 1;
  // 改过的名字（收入也能改）。不能和别的类撞：别的类的原名（含改名前的旧名）、别的类改的名字都不行——
  // 快捷指令发来的是名字，撞了就分不清是哪一类（2026-10-18）
  const names = {};
  const nm = src.names && typeof src.names === 'object' ? src.names : {};
  const owners = new Map(CATEGORY_OPTIONS.map((c) => [plainName(c), c]));
  for (const [old, now] of Object.entries(RENAMED_CATEGORIES)) owners.set(plainName(old), now);
  const taken = new Set();
  for (const c of CATEGORY_OPTIONS) {
    const v = cleanName(nm[c]);
    if (!v || v === c) continue;
    const p = plainName(v);
    const owner = owners.get(p);
    if ((owner && owner !== c) || taken.has(p)) continue;
    taken.add(p);
    names[c] = v;
  }
  const aliases = {};
  const rawAliases = src.aliases && typeof src.aliases === 'object' && !Array.isArray(src.aliases) ? src.aliases : {};
  for (const c of CATEGORY_OPTIONS) {
    if (!Array.isArray(rawAliases[c])) continue;
    const values = [...new Set(rawAliases[c].map(cleanName).filter(Boolean))];
    if (values.length) aliases[c] = values;
  }
  return { v: VERSION, separate, gains, rules, budgets, yearBudgets, yearStart, names, aliases };
}

// 设置缓存按 cacheKey 隔离（同一实例可能服务多个租户，设置绝不能串）
const caches = new Map();
function cacheSlot() {
  const k = cacheKey();
  let slot = caches.get(k);
  if (!slot) caches.set(k, (slot = { at: 0, value: null }));
  return slot;
}
async function readRow() {
  const t = await findTable(TABLE);
  if (!t) return { tableId: '', row: null };
  const items = await search(t, { field_names: ['键', '值'] });
  return { tableId: t, row: items.find((it) => cellText(it.fields['键']) === 'settings') ?? null };
}

// 给提醒用：读一次缓存 10 分钟（一个函数实例里）
// maxAgeMs：缓存多久算新。快捷指令取分类菜单要新一点（刚在看板改了名，下一笔就该用新名字）
async function getSettings(maxAgeMs = 10 * 60e3) {
  const slot = cacheSlot();
  if (slot.value && Date.now() - slot.at < maxAgeMs) return slot.value;
  const { row } = await readRow();
  let v = clean(DEFAULTS);
  if (row) {
    try {
      v = clean(JSON.parse(cellText(row.fields['值'])));
    } catch {}
  }
  slot.at = Date.now();
  slot.value = v;
  return v;
}

// 只改了几项（2026-10-07）：看板改一项就只发那一项，合进飞书里现在那份再存——别的设备、别的会话刚改过的不会被一份旧的整份盖掉
// （那天大件的「从 9 月算起」就是被手机上一份旧设置整份存回去冲成了 1 月）。
// gains / rules / budgets / yearBudgets / names 按类目合并，值是 null = 删掉这一类；separate、yearStart 整个换
const MAPS = ['gains', 'rules', 'budgets', 'yearBudgets', 'names'];
function mergePatch(cur, patch) {
  const out = { ...cur };
  if (!patch || typeof patch !== 'object') return out;
  for (const k of MAPS) {
    if (!patch[k] || typeof patch[k] !== 'object' || Array.isArray(patch[k])) continue;
    const m = { ...(cur[k] || {}) };
    for (const [c, v] of Object.entries(patch[k])) {
      if (v == null) delete m[c];
      else m[c] = v;
    }
    out[k] = m;
  }
  if (Array.isArray(patch.separate)) out.separate = patch.separate;
  if (patch.yearStart !== undefined) out.yearStart = patch.yearStart;
  return out;
}

async function currentSettings() {
  const { row } = await readRow();
  if (!row) return clean(DEFAULTS);
  try {
    return clean(JSON.parse(cellText(row.fields['值'])));
  } catch {
    return clean(DEFAULTS);
  }
}

async function saveSettings(s) {
  const v = clean(s);
  const fields = { 键: 'settings', 值: JSON.stringify(v), 更新时间: Date.now() };
  const { tableId, row } = await readRow();
  const t = tableId || (await findTable(TABLE, FIELDS));
  if (row) await call(`${tables()}/${t}/records/${row.record_id}`, { method: 'PUT', body: { fields } });
  else await call(`${tables()}/${t}/records`, { method: 'POST', body: { fields } });
  const slot = cacheSlot();
  slot.at = Date.now();
  slot.value = v;
  return v;
}

function rememberNames(before, next) {
  const { storedCategory } = require('./category-sync.js');
  const aliases = { ...(before.aliases || {}) };
  for (const c of CATEGORY_OPTIONS) {
    const previous = storedCategory(c, before.names);
    const target = storedCategory(c, next.names);
    if (previous === target) continue;
    aliases[c] = [...new Set([...(aliases[c] || []), previous])];
  }
  // 旧名称仍可能出现在离线缓存或迁移中的表格里，不能让另一类占用。
  const owners = new Map();
  for (const c of CATEGORY_OPTIONS) {
    for (const name of [c, storedCategory(c, next.names), ...(aliases[c] || [])]) {
      const key = plainName(name);
      if (owners.has(key) && owners.get(key) !== c) throw new Error(`分类名「${name}」与其他分类的历史名称冲突`);
      owners.set(key, c);
    }
  }
  return { ...next, aliases };
}

async function syncCategoryNames(settings) {
  const { planCategoryOptions } = require('./category-sync.js');
  const path = `${tables()}/${configOf('TABLE_ID')}/fields`;
  const readField = async () => {
    let token = '';
    let field = null;
    do {
      const page = await call(`${path}?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ''}`);
      field = (page.items || []).find((item) => item.field_name === '账单类目') || field;
      token = page.has_more ? page.page_token : '';
    } while (token && !field);
    return field;
  };
  const field = await readField();
  const plan = planCategoryOptions(field, {}, settings.names, settings.aliases);
  if (!plan) return false;
  try {
    await call(`${path}/${field.field_id}`, { method: 'PUT', body: plan });
  } catch (error) {
    // 另一设备可能同时完成了同一改名，或请求已生效但响应丢失；读回后再判断。
    const fresh = await readField();
    if (planCategoryOptions(fresh, {}, settings.names, settings.aliases)) throw error;
    return true;
  }
  if (planCategoryOptions(await readField(), {}, settings.names, settings.aliases)) throw new Error('飞书分类尚未更新，请重试');
  return true;
}

function reply(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

async function handle(event) {
  if (event.method !== 'POST') return reply(405, { ok: false });
  let req;
  try {
    req = JSON.parse(event.body || '{}');
  } catch {
    return reply(400, { ok: false, error: 'bad_json' });
  }
  const want = configOf('API_TOKEN');
  if (!want || !req?.token || !safeEqual(req.token, want)) {
    await new Promise((r) => setTimeout(r, AUTH_FAIL_DELAY_MS));
    return reply(401, { ok: false, error: 'unauthorized' });
  }
  try {
    if (req.syncNames === true) {
      const settings = await currentSettings();
      const changed = await syncCategoryNames(settings);
      return reply(200, { ok: true, settings, saved: true, changed });
    }
    if (req.patch !== undefined || req.settings !== undefined) {
      const before = await currentSettings();
      const next = rememberNames(before, clean(req.patch !== undefined ? mergePatch(before, req.patch) : req.settings));
      const settings = await saveSettings(next);
      if (req.patch?.names !== undefined || JSON.stringify(before.names) !== JSON.stringify(settings.names)) {
        try { await syncCategoryNames(settings); }
        catch (e) { console.error(e); return reply(200, { ok: true, settings, saved: true, syncWarning: e.message }); }
      }
      return reply(200, { ok: true, settings, saved: true });
    }
    return reply(200, { ok: true, settings: await currentSettings(), saved: true });
  } catch (e) {
    console.error(e);
    return reply(502, { ok: false, error: 'feishu_error', message: e.message });
  }
}

// 双轨入口：线上版先解析租户、注入上下文；改设置是写操作，会员过期时返回 402
module.exports = { handle: withTenant(handle, { write: true }), getSettings, clean, cleanName, plainName, mergePatch, rememberNames, syncCategoryNames, DEFAULTS, _reset: () => caches.clear() };
