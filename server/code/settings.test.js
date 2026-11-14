'use strict';
// 看板设置：只收认得的分类；「得到了」去掉开头的「得到了」、最多 12 个字；没存过就是默认（2026-10-07 起三餐、日常也有「得到了日常」）
const test = require('node:test');
const assert = require('node:assert');
const { clean, mergePatch, DEFAULTS } = require('./settings.js');

test('默认：大额、住房、外出单独列出；八类各有「得到了什么」，三餐、日常都是「生活」', () => {
  const d = clean(DEFAULTS);
  assert.deepEqual(d.separate, ['💰投资蜕变·大额', '🚪外出', '🏠住房']);
  assert.equal(d.gains['✨值得体验'], '体验');
  assert.equal(d.gains['🚪外出'], '阅历');
  assert.equal(d.gains['🍲一日三餐'], '生活');
  assert.equal(d.gains['🛍️生活日常'], '生活');
  assert.equal(Object.keys(d.gains).length, 8);
});

test('清洗：不认得的分类丢掉；收入不能单独列；「得到了」去前缀、限长；空的丢掉', () => {
  const v = clean({ separate: ['🏠住房', '💳收入', '奇怪的'], gains: { '✨值得体验': '得到了快乐', '🍲一日三餐': '饱', '👌投资蜕变': '一二三四五六七八九十十一十二十三', '🏷️人情': '   ' } });
  assert.deepEqual(v.separate, ['🏠住房']);
  assert.deepEqual(v.gains, { '🍲一日三餐': '饱', '✨值得体验': '快乐', '👌投资蜕变': '一二三四五六七八九十十一' });
});

test('哪种钱放哪：八类都认（含三餐、日常）；空的丢掉；压掉换行、限长；没存过用默认', () => {
  const d = clean(DEFAULTS);
  assert.equal(Object.keys(d.rules).length, 8);
  assert.equal(d.rules['🏠住房'].avoid, undefined);
  const long = '游'.repeat(250);
  const v = clean({ rules: { '🍲一日三餐': { put: ' 饭、\n 饮品 ', avoid: '' }, '✨值得体验': { put: long }, '🏷️人情': { put: '  ' }, '💳收入': { put: '工资' }, '奇怪的': { put: 'x' } } });
  assert.deepEqual(v.rules, { '🍲一日三餐': { put: '饭、 饮品' }, '✨值得体验': { put: '游'.repeat(200) } });
  assert.deepEqual(clean({ separate: [] }).rules, d.rules);
});

test('坏数据：当成没设，用默认', () => {
  assert.deepEqual(clean(null), clean(DEFAULTS));
  assert.deepEqual(clean('x'), clean(DEFAULTS));
});

test('每月额度：只收认得的分类、正数；不填就没有', () => {
  const v = clean({ ...DEFAULTS, budgets: { '🍲一日三餐': '1000', '✨值得体验': 800.555, '🏠住房': -5, '💳收入': 9000, '🛍️生活日常': 'abc' } });
  assert.deepEqual(v.budgets, { '🍲一日三餐': 1000, '✨值得体验': 800.56 });
  assert.deepEqual(clean(DEFAULTS).budgets, {});
});

test('按年的额度：认得的分类、正数；起算月 1–12，不对就是 1 月', () => {
  const d = clean(DEFAULTS);
  assert.deepEqual(d.yearBudgets, {});
  assert.equal(d.yearStart, 1);
  const v = clean({ yearBudgets: { '💰投资蜕变·大额': '8000.456', 奇怪的: 5, '🚪外出': -1 }, yearStart: 4 });
  assert.deepEqual(v.yearBudgets, { '💰投资蜕变·大额': 8000.46 });
  assert.equal(v.yearStart, 4);
  for (const bad of [0, 13, 2.5, '三月', null]) assert.equal(clean({ yearStart: bad }).yearStart, 1);
  assert.deepEqual(clean({ budgets: { '🍲一日三餐': 900 } }).budgets, { '🍲一日三餐': 900 }, '存年额度不碰每月额度');
});

test('类目改过名：存着的旧名字（开心购物、其他）挪到新名字下；新名字已经有了就以新的为准', () => {
  const v = clean({ separate: ['🏷️其他'], gains: { '✨开心购物': '快乐', '🏷️其他': '人情味' }, budgets: { '✨开心购物': 300 }, rules: { '🏷️其他': { put: '红包' } }, yearBudgets: {} });
  assert.deepEqual(v.separate, ['🏷️人情']);
  assert.equal(v.gains['✨值得体验'], '快乐');
  assert.equal(v.gains['🏷️人情'], '人情味');
  assert.equal(v.gains['✨开心购物'], undefined);
  assert.deepEqual(v.budgets, { '✨值得体验': 300 });
  assert.equal(v.rules['🏷️人情'].put, '红包');
  assert.deepEqual(clean({ budgets: { '✨开心购物': 300, '✨值得体验': 600 } }).budgets, { '✨值得体验': 600 });
});

test('只改几项：按类目合并进现在那份，别处改过的不被盖掉；null = 删掉这一类', () => {
  const cur = clean({ ...DEFAULTS, budgets: { '🍲一日三餐': 900, '✨值得体验': 300 }, yearBudgets: { '💰投资蜕变·大额': 8000 }, yearStart: 4 });
  const v = clean(mergePatch(cur, { budgets: { '✨值得体验': 450, '🍲一日三餐': null } }));
  assert.deepEqual(v.budgets, { '✨值得体验': 450 });
  assert.equal(v.yearStart, 4, '没发的字段原样留着');
  assert.deepEqual(v.yearBudgets, { '💰投资蜕变·大额': 8000 });
  assert.equal(clean(mergePatch(cur, { yearStart: 7 })).yearStart, 7);
  assert.deepEqual(clean(mergePatch(cur, { gains: { '🚪外出': '远方' } })).gains['🚪外出'], '远方');
  assert.equal(clean(mergePatch(cur, { gains: { '🚪外出': '远方' } })).gains['🏠住房'], '安稳', '别的类的「得到了」不动');
});

test('分类改名：存「emoji + 名字」；去空格、最多 8 个字；空的、和原名一样的、不认得的类不存；收入也能改', () => {
  const v = clean({ ...DEFAULTS, names: { '✨值得体验': '🎮 娱乐', '👌投资蜕变': '  学习  成长 ', '🍲一日三餐': '🍲一日三餐', '🛍️生活日常': '   ', '💳收入': '💰进账', '🐶宠物': '🐶狗' } });
  assert.deepEqual(v.names, { '✨值得体验': '🎮娱乐', '👌投资蜕变': '学习 成长', '💳收入': '💰进账' });
  assert.equal(clean({ names: { '🏷️人情': '一二三四五六七八九十' } }).names['🏷️人情'], '一二三四五六七八', '最多 8 个字');
  assert.deepEqual(clean(DEFAULTS).names, {}, '没改过就是空的');
  assert.deepEqual(clean({ names: 'x' }).names, {}, '坏数据当没改');
  assert.equal(clean({ names: { '✨开心购物': '🎮娱乐' } }).names['✨值得体验'], '🎮娱乐', '旧类目名的键挪到新名字下');
});

test('分类改名：只发改了的那一类；null = 改回原名，别的类的名字不动', () => {
  const cur = clean({ ...DEFAULTS, names: { '✨值得体验': '🎮娱乐', '🏷️人情': '🎁送礼' } });
  assert.deepEqual(clean(mergePatch(cur, { names: { '✨值得体验': null } })).names, { '🏷️人情': '🎁送礼' });
  assert.deepEqual(clean(mergePatch(cur, { names: { '🚪外出': '✈️旅行' } })).names, { '✨值得体验': '🎮娱乐', '🏷️人情': '🎁送礼', '🚪外出': '✈️旅行' });
});

test('分类改名：不能和别的类的原名、旧名、别的类改的名字撞（快捷指令发来的名字要能认回唯一一类）', () => {
  const v = clean({ names: { '✨值得体验': '🎮 一日三餐', '👌投资蜕变': '其他', '🚪外出': '🍲出去玩', '🏠住房': '出去玩', '🍲一日三餐': '🍜一日三餐' } });
  assert.equal(v.names['✨值得体验'], undefined, '撞了「一日三餐」的原名');
  assert.equal(v.names['👌投资蜕变'], undefined, '撞了「其他」这个旧名（老快捷指令发的是人情）');
  assert.equal(v.names['🚪外出'], '🍲出去玩');
  assert.equal(v.names['🏠住房'], undefined, '和外出改的名字撞了');
  assert.equal(v.names['🍲一日三餐'], '🍜一日三餐', '只换图标、名字和自己原名一样：可以');
});

test('旧设置（没有 v）：三餐、日常的「得到了」还是旧默认「日常」的换成「生活」；改过的不动；存过 v=2 以后改回「日常」照存', () => {
  const old = { ...DEFAULTS, gains: { ...DEFAULTS.gains, '🍲一日三餐': '日常', '🛍️生活日常': '日常', '✨值得体验': '日常' } };
  const v = clean(old);
  assert.equal(v.v, 2);
  assert.equal(v.gains['🍲一日三餐'], '生活');
  assert.equal(v.gains['🛍️生活日常'], '生活');
  assert.equal(v.gains['✨值得体验'], '日常', '别的类自己写的「日常」不动');
  assert.equal(clean({ ...old, gains: { '🍲一日三餐': '饱' } }).gains['🍲一日三餐'], '饱');
  const again = clean(mergePatch(v, { gains: { '🍲一日三餐': '日常' } }));
  assert.equal(again.gains['🍲一日三餐'], '日常', '新版本里用户自己选的「日常」照存');
  assert.equal(clean(again).gains['🍲一日三餐'], '日常', '再读一次也还是');
});
