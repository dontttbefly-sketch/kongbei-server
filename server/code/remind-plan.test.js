'use strict';
// 备注提醒的排期：1 小时后、12 小时后、当天 21:00、下一个 8:00；23–8 点不推；离汇总太近的单笔跳过
const test = require('node:test');
const assert = require('node:assert');
const { planReminders, recordMessage, digestMessage, whenText } = require('./remind-plan.js');

const bj = (s) => Date.parse(`${s}+08:00`);
const show = (plan) => plan.map((p) => `${new Date(p.at + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')} ${p.body.type === 'digest' ? `汇总${p.body.slot}` : p.body.slot}`);

test('下午 2:05 记的：3:05 问一次；12 小时后是凌晨 2:05（不推）；晚 9 点、明早 8 点汇总', () => {
  assert.deepEqual(show(planReminders('recA', bj('2026-10-07T14:05:00'))), ['10-07 15:05 1h', '10-07 21:00 汇总21', '10-08 08:00 汇总08']);
});

test('早上 8:30 记的：9:30 问一次；12 小时后 20:30 离 21 点汇总太近，跳过（汇总会带上它）', () => {
  assert.deepEqual(show(planReminders('recB', bj('2026-10-07T08:30:00'))), ['10-07 09:30 1h', '10-07 21:00 汇总21', '10-08 08:00 汇总08']);
});

test('晚上 8:40 记的：1 小时后 21:40 离汇总太近，跳过；只剩晚 9 点、明早 8 点', () => {
  assert.deepEqual(show(planReminders('recC', bj('2026-10-07T20:40:00'))), ['10-07 21:00 汇总21', '10-08 08:00 汇总08']);
});

test('夜里 11:30 记的：当天 21 点已过；1 小时后在夜里；明早 8 点汇总、中午 11:30 再问一次', () => {
  assert.deepEqual(show(planReminders('recD', bj('2026-10-07T23:30:00'))), ['10-08 08:00 汇总08', '10-08 11:30 12h']);
});

test('清晨 6 点记的：7 点在夜里不推；今天 8 点就是「下一个 8 点」；傍晚 6 点再问；晚 9 点汇总', () => {
  assert.deepEqual(show(planReminders('recE', bj('2026-10-07T06:00:00'))), ['10-07 08:00 汇总08', '10-07 18:00 12h', '10-07 21:00 汇总21']);
});

test('汇总按日期防重复：同一天记的几笔，晚 9 点只会有一条', () => {
  const a = planReminders('r1', bj('2026-10-07T10:00:00')).find((p) => p.body.slot === '21');
  const b = planReminders('r2', bj('2026-10-07T16:00:00')).find((p) => p.body.slot === '21');
  assert.equal(a.dedupId, 'digest-2026-10-07-21');
  assert.equal(a.dedupId, b.dedupId);
  assert.equal(planReminders('r1', bj('2026-10-07T10:00:00')).find((p) => p.body.slot === '1h').dedupId, 'rec-r1-1h');
});

test('问法：金额、时候填进去；值得体验会抽到它专属的问法；汇总一笔 / 几笔说法不同', () => {
  const now = bj('2026-10-07T21:00:00');
  const r = { id: 'x', amount: -42, category: '✨值得体验', time: bj('2026-10-07T12:10:00') };
  assert.equal(whenText(r.time, now), '今天中午');
  assert.equal(whenText(bj('2026-10-06T19:00:00'), now), '昨天晚上');
  const bodies = new Set(Array.from({ length: 200 }, () => recordMessage('1h', r, now).body));
  assert.ok([...bodies].every((b) => b.includes('¥42')));
  assert.ok([...bodies].some((b) => /体验|快乐/.test(b)), '值得体验专属的问法');
  assert.ok(bodies.size > 6, '花样够多');
  const many = digestMessage('21', [r, { ...r, amount: -18.5 }], now, () => 0.99);
  assert.match(many.body, /¥60\.5/);
  const one = digestMessage('08', [r], now, () => 0);
  assert.match(one.body, /¥42/);
  assert.ok(!/\{\w+\}/.test(one.body + many.body), '没有没填上的占位');
});

test('有「得到了什么」时，问法里会抽到它（填上那个词，不留占位）', () => {
  const now = Date.parse('2026-10-07T15:00:00+08:00');
  const r = { id: 'x', amount: -300, category: '🚪外出', time: now - 3600e3 };
  const gains = { '🚪外出': '阅历' };
  const bodies = new Set(Array.from({ length: 300 }, () => recordMessage('1h', r, now, Math.random, gains).body));
  assert.ok([...bodies].some((b) => b.includes('阅历')));
  assert.ok([...bodies].every((b) => !/\{\w+\}|undefined/.test(b)));
  const twelve = new Set(Array.from({ length: 200 }, () => recordMessage('12h', r, now, Math.random, gains).body));
  assert.ok([...twelve].some((b) => b.includes('阅历')));
  const none = new Set(Array.from({ length: 200 }, () => recordMessage('1h', r, now).body));
  assert.ok([...none].every((b) => !b.includes('undefined')), '没设「得到」时不出现 undefined');
});

test('英文：设备选了英文就用英文问（金额、时候填好，不留占位，不出现中文）', () => {
  const now = bj('2026-10-07T21:00:00');
  const r = { id: 'x', amount: -42, category: '✨值得体验', time: bj('2026-10-07T12:10:00') };
  assert.equal(whenText(r.time, now, 'en'), 'lunch today');
  assert.equal(whenText(bj('2026-10-06T19:00:00'), now, 'en'), 'last night');
  assert.equal(whenText(bj('2026-10-01T09:00:00'), now, 'en'), 'Oct 1');
  assert.equal(whenText(r.time, now), '今天中午', '不传语言还是中文');
  const han = /[一-鿿]/;
  const clean = (m) => !han.test(m.title + m.body) && !/\{\w+\}|undefined/.test(m.body);
  const one = Array.from({ length: 300 }, () => recordMessage('1h', r, now, Math.random, {}, 'en'));
  assert.ok(one.every((m) => m.body.includes('¥42') && clean(m)));
  assert.ok(one.some((m) => /experience|joy|enjoy/i.test(m.body)), '值得体验专属的英文问法');
  assert.ok(one.some((m) => m.body.includes('under Experiences')), '带类目英文名的问法');
  const twelve = Array.from({ length: 200 }, () => recordMessage('12h', r, now, Math.random, {}, 'en'));
  assert.ok(twelve.every(clean));
  const many = digestMessage('21', [r, { ...r, amount: -18.5 }], now, () => 0.99, 'en');
  assert.match(many.body, /¥60\.5/);
  const single = digestMessage('08', [r], now, () => 0, 'en');
  assert.match(single.body, /¥42 from lunch today/);
  assert.ok(clean(many) && clean(single));
});

test('英文：「得到了什么」还是默认值的换成英文默认值，自己改过的原样用；中文设备看到中文默认值', () => {
  const now = bj('2026-10-07T15:00:00');
  const r = { id: 'x', amount: -300, category: '🚪外出', time: now - 3600e3 };
  const bodies = (gains, lang) => new Set(Array.from({ length: 400 }, () => recordMessage('1h', r, now, Math.random, gains, lang).body));
  const en = bodies({ '🚪外出': '阅历' }, 'en');
  assert.ok([...en].some((b) => b.includes('"Seeing the world"')));
  assert.ok([...en].every((b) => !b.includes('阅历')));
  assert.ok([...bodies({ '🚪外出': 'road trips' }, 'en')].some((b) => b.includes('road trips')), '自己改过的原样用');
  const zh = bodies({ '🚪外出': 'Seeing the world' });
  assert.ok([...zh].some((b) => b.includes('阅历')), '设置里存的是英文默认值时，中文设备看到中文默认值');
});

test('改过名的分类：英文问法里提到类目时用用户起的名字', () => {
  const r = { amount: -45, category: '✨值得体验', time: Date.now() - 3600e3 };
  const bodies = Array.from({ length: 400 }, () => recordMessage('1h', r, Date.now(), Math.random, {}, 'en', { '✨值得体验': '🎮Games' }).body).join('\n');
  assert.ok(bodies.includes('Games'), '用了新名字');
  assert.ok(!bodies.includes('Experiences'), '不再用默认的英文名');
});
