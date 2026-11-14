'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { storedCategory, canonicalCategory, planCategoryOptions } = require('./category-sync.js');
const { clean, rememberNames } = require('./settings.js');
const { fieldsOf } = require('./edit.js');

const field = () => ({ field_id: 'fld1', field_name: '账单类目', type: 3, property: { options: [
  { id: 'opt1', name: '🍲一日三餐', color: 4 },
  { id: 'opt2', name: '🛍️生活日常', color: 2 },
  { id: 'opt3', name: '自己加的分类', color: 7 },
] } });

test('分类显示名作为飞书选项名，缺图标沿用原来的图标', () => {
  assert.equal(storedCategory('🍲一日三餐', { '🍲一日三餐': '🍜餐饮' }), '🍜餐饮');
  assert.equal(storedCategory('🍲一日三餐', { '🍲一日三餐': '早 午餐' }), '🍲早 午餐');
  assert.equal(storedCategory('🍲一日三餐'), '🍲一日三餐');
});

test('修改分类时保留选项 ID、颜色和所有无关选项', () => {
  const current = field();
  const planned = planCategoryOptions(current, {}, { '🍲一日三餐': '🍜餐饮' });
  assert.deepEqual(planned.property.options, [
    { id: 'opt1', name: '🍜餐饮', color: 4 },
    { id: 'opt2', name: '🛍️生活日常', color: 2 },
    { id: 'opt3', name: '自己加的分类', color: 7 },
  ]);
  assert.equal(current.property.options[0].name, '🍲一日三餐');
});

test('再次改名和恢复原名以当前选项为起点', () => {
  const current = field();
  current.property.options[0].name = '🍜餐饮';
  assert.equal(planCategoryOptions(current, { '🍲一日三餐': '🍜餐饮' }, { '🍲一日三餐': '🍝美食' }).property.options[0].name, '🍝美食');
  assert.equal(planCategoryOptions(current, { '🍲一日三餐': '🍜餐饮' }, {}).property.options[0].name, '🍲一日三餐');
});

test('目标选项已经存在时拒绝直接覆盖，防止清空别的历史记录', () => {
  const current = field();
  current.property.options.push({ id: 'opt4', name: '🍜餐饮', color: 1 });
  assert.throws(() => planCategoryOptions(current, {}, { '🍲一日三餐': '🍜餐饮' }), /多个选项/);
  assert.equal(planCategoryOptions(field(), {}, {}), null);
  assert.throws(() => planCategoryOptions({ field_name: '账单类目', type: 1 }, {}, {}), /单选/);
});

test('改名后新、旧名称和无图标名称都映射回同一内部分类，未知分类原样保留', () => {
  const names = { '🍲一日三餐': '🍝美食' };
  const aliases = { '🍲一日三餐': ['🍜餐饮'] };
  for (const name of ['🍝美食', '美食', '🍜餐饮', '餐饮', '🍲一日三餐']) assert.equal(canonicalCategory(name, names, aliases), '🍲一日三餐');
  assert.equal(canonicalCategory('用户自建分类', names, aliases), '用户自建分类');
  assert.equal(fieldsOf({ category: '🍲一日三餐' }, names)['账单类目'], '🍝美食');
});

test('连续改名保留历史别名，不允许其他分类占用这些名称', () => {
  const initial = clean({ names: { '🍲一日三餐': '🍜餐饮' } });
  const next = rememberNames(initial, clean({ names: { '🍲一日三餐': '🍝美食' } }));
  assert.deepEqual(next.aliases['🍲一日三餐'], ['🍜餐饮']);
  const restored = rememberNames(next, clean({ names: {} }));
  assert.deepEqual(restored.aliases['🍲一日三餐'], ['🍜餐饮', '🍝美食']);
  assert.throws(() => rememberNames(restored, clean({ names: { '🛍️生活日常': '🍜餐饮' } })), /历史名称冲突/);
});

test('之前已在看板改名的分类会从飞书原选项迁移；重复执行不再修改', () => {
  const current = field();
  const names = { '🍲一日三餐': '🍜餐饮' };
  const changed = planCategoryOptions(current, {}, names);
  assert.equal(changed.property.options[0].name, '🍜餐饮');
  assert.equal(planCategoryOptions({ ...current, property: changed.property }, {}, names), null);
});
