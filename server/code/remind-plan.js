'use strict';
// 备注提醒的排期和问法（用户 2026-10-07 定的）：
//   记下一笔没写备注的账 → 这一笔 1 小时后、12 小时后各问一次；当天 21:00、下一个 8:00 各推一条汇总（几笔合成一条）。
//   23:00–8:00 不推（落在夜里的跳过，由早上 8 点那条兜底）；单笔提醒离汇总太近（汇总前 30 分钟到后 60 分钟内）也跳过，汇总会带上它。
// 全部按北京时间算

const TZ = 8 * 3600e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

const bj = (ms) => new Date(ms + TZ); // 用 getUTC* 读出来的就是北京时间
const quiet = (ms) => {
  const h = bj(ms).getUTCHours();
  return h >= 23 || h < 8;
};
// 北京时间某天（ms 所在那天）几点
const atHour = (ms, h) => Math.floor((ms + TZ) / DAY) * DAY - TZ + h * HOUR;
const ymd = (ms) => bj(ms).toISOString().slice(0, 10);

// 汇总的时刻：当天 21:00（还没到才算）、下一个 8:00
function digestTimes(createdAt) {
  const out = [];
  const nine = atHour(createdAt, 21);
  if (nine > createdAt) out.push({ at: nine, slot: '21' });
  let eight = atHour(createdAt, 8);
  if (eight <= createdAt) eight += DAY;
  out.push({ at: eight, slot: '08' });
  return out.sort((a, b) => a.at - b.at);
}

// 一笔账要预约的全部提醒：[{ at, body, dedupId }]
function planReminders(id, createdAt) {
  const digests = digestTimes(createdAt);
  const out = digests.map((d) => ({ at: d.at, body: { type: 'digest', slot: d.slot, at: d.at }, dedupId: `digest-${ymd(d.at)}-${d.slot}` }));
  for (const [slot, delay] of [
    ['1h', HOUR],
    ['12h', 12 * HOUR],
  ]) {
    const at = createdAt + delay;
    if (quiet(at)) continue;
    if (digests.some((d) => d.at >= at - HOUR && d.at <= at + 30 * 60e3)) continue;
    out.push({ at, body: { type: 'record', slot, id, createdAt }, dedupId: `rec-${id}-${slot}` });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ── 问法：按时间段、类目随机抽，友好、好玩，不说教 ─────────────────
const pick = (xs, rnd = Math.random) => xs[Math.floor(rnd() * xs.length)];
const money = (n) => `¥${Math.abs(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

// 「早上」「下午」「昨天晚上」：那一笔是什么时候记的。英文（lang = 'en'）：this morning / yesterday afternoon / last night / Oct 6
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WHEN_EN = {
  today: ['early this morning', 'this morning', 'lunch today', 'this afternoon', 'this evening'],
  yesterday: ['early yesterday', 'yesterday morning', 'lunch yesterday', 'yesterday afternoon', 'last night'],
};
function whenText(ms, now, lang = 'zh') {
  const h = bj(ms).getUTCHours();
  const i = h < 5 ? 0 : h < 11 ? 1 : h < 14 ? 2 : h < 18 ? 3 : 4;
  const days = Math.floor((now + TZ) / DAY) - Math.floor((ms + TZ) / DAY);
  if (lang === 'en') return days === 0 ? WHEN_EN.today[i] : days === 1 ? WHEN_EN.yesterday[i] : `${MONTH_EN[bj(ms).getUTCMonth()]} ${bj(ms).getUTCDate()}`;
  const part = ['凌晨', '早上', '中午', '下午', '晚上'][i];
  return days === 0 ? `今天${part}` : days === 1 ? `昨天${part}` : `${bj(ms).getUTCMonth() + 1}月${bj(ms).getUTCDate()}日`;
}

const TITLES = ['叮～', '小账本敲敲门', '有一笔账在等你', '补个备注？', '来认领一下', '一个小问题', '空杯小助手'];

const ONE_HOUR = [
  '刚刚那笔 {amt} 是干嘛啦？趁还记得，说一句～',
  '{amt} 悄悄溜走了，它去哪儿了？',
  '叮！一笔 {amt} 还没有名字，给它起一个吧',
  '刚才花的 {amt}，是买快乐还是买必需？写一句备注吧',
  '这笔 {amt} 有什么故事？十个字就够',
  '{amt} 举手：我是谁？我被花在了哪儿？',
  '趁记忆还热乎，{amt} 这笔是啥？',
  '一笔 {amt} 正在等它的名字，点开写一句？',
];
const BY_CATEGORY = {
  生活日常: ['{amt} 的生活日常，是买了家里缺的什么？', '日常开销 {amt}：超市、打车，还是别的？', '{amt} 让日子更顺了一点，它是什么？'],
  值得体验: ['值得体验 {amt}！体验了什么，说来听听？', '{amt} 换来了什么快乐？写下来，以后回味', '这次 {amt} 的体验是什么？记一句'],
  投资蜕变: ['投资自己 {amt}，是课、是书，还是健身？', '{amt} 花在了变更好的路上，具体是哪条路？'],
  外出: ['出门在外的 {amt}，是车票、住宿，还是好吃的？', '旅途中的 {amt}，记下它是什么，回来翻账就是游记'],
  '投资蜕变·大额': ['大额 {amt}！这么重要的一笔，写清楚它是什么吧', '{amt} 可不是小数目，给它留句话？'],
  住房: ['住房 {amt}：房租、水电，还是别的？'],
  人情: ['人情 {amt}——是给谁的？记一句', '一笔人情 {amt}，是什么场合？'],
};
// 跟着「得到了什么」问（2026-10-07 用户定的每类「得到了」，设置页里能改）
const BY_GAIN = ['这笔 {amt} 让你得到了{gain}——具体是什么？', '{amt} 记在「得到了{gain}」名下，它是什么呀？', '得到了{gain}的 {amt}，写一句它是什么吧', '这次的 {amt}，得到的{gain}是什么样的？'];
const TWELVE_BY_GAIN = ['{when}那笔 {amt}（得到了{gain}）还没备注，是什么来着？', '半天了，{when}那份「{gain}」花了 {amt}，记一句它是什么？'];
const TWELVE_HOURS = [
  '{when}那笔 {amt} 还没有备注，现在还想得起来吗？',
  '{amt} 等了你半天啦，给它一句话吧',
  '半天过去了，{when}的 {amt} 是花在哪的？',
  '嘿，{when}那笔 {amt} 还是个谜，来揭晓一下？',
  '{when}的 {amt} 在账本里闲着，给它写个备注？',
];
const NIGHT_MANY = [
  '今天有 {n} 笔账还没写备注，睡前花 10 秒认领一下？',
  '今日账本还差 {n} 个备注，补完就可以安心睡啦',
  '{n} 笔小账在排队等名字，一笔一句就好',
  '收工前清个账：今天有 {n} 笔没备注，合计 {sum}',
];
const NIGHT_ONE = ['今天还有一笔 {amt} 没写备注，补一句再休息？', '睡前小任务：{when}那笔 {amt} 是什么？', '今天就差一个备注了：{amt}，写完收工～'];
const MORNING_MANY = ['早安！昨天还有 {n} 笔在等你说说它们的故事', '新的一天，先把 {n} 个备注补上？一分钟搞定', '早上好～有 {n} 笔账还没名字，合计 {sum}'];
const MORNING_ONE = ['早安！{when}那笔 {amt} 还在等一个备注', '早上好，{when}那笔 {amt} 是什么来着？', '新的一天从补一个备注开始：{amt}'];

// ── 英文问法（设备选了英文：订阅里存着 lang = 'en'）：和上面一一对应，同样友好、好玩、不说教 ──
// {when} 只放在 from 后面（「from this morning」「from last night」），不放句首、不加 's
const TITLES_EN = ['Ding!', 'Your ledger is knocking', 'A record is waiting', 'Add a note?', 'Claim this one', 'Quick question', 'Kongbei here'];
const ONE_HOUR_EN = [
  'What was that {amt} just now? Jot it down while you remember',
  '{amt} slipped away quietly. Where did it go?',
  'Ding! A {amt} spend has no name yet. Give it one?',
  'The {amt} you just spent: joy or necessity? Add a note',
  "What's the story behind this {amt}? A few words will do",
  '{amt} raises its hand: who am I, and where was I spent?',
  "While it's fresh: what was the {amt}?",
  'A {amt} spend is waiting for its name. Tap to add a note?',
];
const ONE_HOUR_CAT_EN = ['{amt} under {cat}: what was it?'];
const BY_CATEGORY_EN = {
  生活日常: ['{amt} on everyday stuff: something the house ran out of?', 'Everyday spending, {amt}: groceries, a taxi, or something else?', '{amt} made life a little smoother. What was it?'],
  值得体验: ['{amt} on an experience! What did you get to enjoy?', 'What joy did {amt} buy? Write it down to savor later', 'What was this {amt} experience? Note it down'],
  投资蜕变: ['{amt} invested in yourself: a course, a book, or the gym?', '{amt} spent on getting better. Which path was it?'],
  外出: ['{amt} while away: tickets, a place to stay, or good food?', '{amt} on the road. Note what it was and your ledger becomes a travel log'],
  '投资蜕变·大额': ['A big one: {amt}! Write down what it was', '{amt} is no small sum. Leave it a note?'],
  住房: ['Housing, {amt}: rent, utilities, or something else?'],
  人情: ['{amt} for someone else: who was it for?', 'A {amt} gift or treat: what was the occasion?'],
};
const BY_GAIN_EN = ['This {amt} went to "{gain}". What exactly was it?', '{amt} filed under "{gain}". What was it?', '{amt} for "{gain}": add a line about what it was?', 'What did "{gain}" look like this time? ({amt})'];
const TWELVE_BY_GAIN_EN = ['The {amt} from {when} ("{gain}") still has no note. What was it?', 'Half a day later: the {amt} from {when} went to "{gain}". What was it?'];
const TWELVE_HOURS_EN = [
  'That {amt} from {when} still has no note. Do you still remember it?',
  '{amt} has been waiting half a day. Give it a line?',
  'Half a day later: where did the {amt} from {when} go?',
  'Hey, the {amt} from {when} is still a mystery. Care to reveal it?',
  'The {amt} from {when} is sitting in your ledger without a note. Add one?',
];
const NIGHT_MANY_EN = [
  '{n} records from today have no note yet. Ten seconds before bed?',
  "Today's ledger is {n} notes short. Fill them in and sleep easy",
  '{n} small records are lining up for names. One line each is enough',
  'Wrap up the day: {n} records without notes, {sum} in total',
];
const NIGHT_ONE_EN = ['One {amt} from today still has no note. Add a line before you rest?', 'Bedtime mini task: what was the {amt} from {when}?', "Just one note left today: {amt}. Write it and you're done"];
const MORNING_MANY_EN = ['Good morning! {n} records from yesterday are waiting for their stories', 'New day: fill in {n} notes first? Takes a minute', 'Morning! {n} records still have no name, {sum} in total'];
const MORNING_ONE_EN = ['Good morning! The {amt} from {when} is still waiting for a note', 'Morning! What was the {amt} from {when}?', 'Start the day with one note: {amt}'];

const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? String(v[k]) : ''));
const catName = (c) => String(c || '').replace(/^[^\p{Script=Han}A-Za-z0-9]+/u, '');

// 类目的英文名（键是去掉 emoji 的中文名，和看板 web/src/lib/i18n.ts 的 CATEGORY_EN 一样）
const CATEGORY_EN = {
  一日三餐: 'Meals',
  生活日常: 'Essentials', // 和看板 web/src/lib/i18n.ts 一致（2026-10-18 从 Everyday 改）
  值得体验: 'Experiences',
  投资蜕变: 'Growth',
  '投资蜕变·大额': 'Growth · Big',
  外出: 'Travel',
  住房: 'Housing',
  人情: 'Gifts',
  收入: 'Income',
  开心购物: 'Experiences',
  其他: 'Gifts',
};
// 「得到了什么」是用户的设置：还是默认值的，按设备语言换成那种语言的默认值（和看板 web/src/lib/settings-en.ts 一样）；改过的原样用
const GAIN_DEFAULTS_ZH = require('./settings-defaults.json').gains;
const GAIN_DEFAULTS_EN = {
  '🍲一日三餐': 'Living',
  '🛍️生活日常': 'Living',
  '✨值得体验': 'Experiences',
  '👌投资蜕变': 'A better me',
  '💰投资蜕变·大额': 'Long-term base',
  '🚪外出': 'Seeing the world',
  '🏠住房': 'A stable home',
  '🏷️人情': 'Relationships',
};
function gainText(category, gain, lang) {
  if (!gain) return gain;
  if (lang === 'en' && gain === GAIN_DEFAULTS_ZH[category]) return GAIN_DEFAULTS_EN[category] ?? gain;
  if (lang !== 'en' && gain === GAIN_DEFAULTS_EN[category]) return GAIN_DEFAULTS_ZH[category] ?? gain;
  return gain;
}

// 一笔：1 小时后（通用、按类目、按「得到了什么」的问法混着抽）、12 小时后。gains = 每类得到了什么（看板设置）。
// lang：这台设备选的语言（'zh' | 'en'），不传就是中文。names = 改过的分类名（看板设置，「emoji + 名字」）
function recordMessage(slot, r, now = Date.now(), rnd = Math.random, gains = {}, lang = 'zh', names = {}) {
  const en = lang === 'en';
  const gain = gainText(r.category, gains[r.category], lang);
  const cat = catName(r.category);
  const v = { amt: money(r.amount), when: whenText(r.time, now, lang), gain, cat: names[r.category] ? catName(names[r.category]) : CATEGORY_EN[cat] };
  const pool = en
    ? slot === '1h'
      ? [...ONE_HOUR_EN, ...(v.cat ? ONE_HOUR_CAT_EN : []), ...(BY_CATEGORY_EN[cat] || []), ...(gain ? BY_GAIN_EN : [])]
      : [...TWELVE_HOURS_EN, ...(gain ? TWELVE_BY_GAIN_EN : [])]
    : slot === '1h'
      ? [...ONE_HOUR, ...(BY_CATEGORY[cat] || []), ...(gain ? BY_GAIN : [])]
      : [...TWELVE_HOURS, ...(gain ? TWELVE_BY_GAIN : [])];
  return { title: pick(en ? TITLES_EN : TITLES, rnd), body: fill(pick(pool, rnd), v) };
}

// 汇总：晚上 9 点 / 早上 8 点；一笔时问那一笔，几笔时说个数和合计
function digestMessage(slot, list, now = Date.now(), rnd = Math.random, lang = 'zh') {
  const en = lang === 'en';
  const first = list[0];
  const v = { n: list.length, sum: money(list.reduce((a, r) => a + Math.abs(r.amount), 0)), amt: money(first.amount), when: whenText(first.time, now, lang) };
  const pool = en
    ? slot === '21'
      ? list.length > 1
        ? NIGHT_MANY_EN
        : NIGHT_ONE_EN
      : list.length > 1
        ? MORNING_MANY_EN
        : MORNING_ONE_EN
    : slot === '21'
      ? list.length > 1
        ? NIGHT_MANY
        : NIGHT_ONE
      : list.length > 1
        ? MORNING_MANY
        : MORNING_ONE;
  return { title: pick(en ? TITLES_EN : TITLES, rnd), body: fill(pick(pool, rnd), v) };
}

module.exports = { planReminders, digestTimes, quiet, whenText, recordMessage, digestMessage, gainText, atHour, DAY, HOUR, CATEGORY_EN };
