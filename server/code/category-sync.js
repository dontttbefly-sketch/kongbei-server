'use strict';

const { labelOf, normalizeCategory, CATEGORY_OPTIONS } = require('./accounting.js');

// 飞书的选项名和看板显示一致；菜单为了可读性加的 emoji 后空格不写入飞书。
function storedCategory(category, names = {}) {
  return labelOf(category, names).replace(/^(\p{Extended_Pictographic}\uFE0F?)\s+/u, '$1');
}

// 内部仍用稳定的分类标识，飞书单元格可以是当前名字、原名或同步期间的旧名字。
function canonicalCategory(value, names = {}, aliases = {}) {
  if (value == null || value === '') return value;
  try { return normalizeCategory(value, names); } catch {}
  const plain = (s) => String(s).replace(/\s+/g, '').replace(/^\p{Extended_Pictographic}\uFE0F?/u, '');
  const matches = Object.entries(aliases).filter(([, list]) => Array.isArray(list) && list.some((name) => plain(name) === plain(value))).map(([category]) => category);
  if (matches.length === 1) return matches[0];
  return value;
}

// 保留每个已有选项的 ID、颜色和其它属性。飞书字段更新是全量更新，不能遗漏别的选项。
// 目标名字已由另一个选项使用时不能直接删除旧选项，否则其历史记录会丢失。
function planCategoryOptions(field, before = {}, after = {}, aliases = {}) {
  if (!field || field.field_name !== '账单类目' || field.type !== 3 || !Array.isArray(field.property?.options)) {
    throw new Error('账单类目不是可更新的单选字段');
  }
  const options = field.property.options;
  if (options.some((option) => !option.id || typeof option.name !== 'string')) throw new Error('分类选项缺少 ID，不能安全更新');
  const owner = new Map(options.map((option) => [option.name, option.id]));
  const renames = new Map();
  for (const category of CATEGORY_OPTIONS) {
    const newName = storedCategory(category, after);
    const sources = new Set([storedCategory(category, {}), storedCategory(category, before), ...(aliases[category] || [])]);
    const present = [...sources].filter((name) => name !== newName && owner.has(name));
    if (!present.length) continue;
    if (present.length > 1 || owner.has(newName)) throw new Error(`飞书里「${newName}」对应多个选项，需要先合并`);
    renames.set(present[0], newName);
  }
  const names = options.map((option) => renames.get(option.name) ?? option.name);
  if (new Set(names).size !== names.length) throw new Error('分类重命名后选项重复，不能安全更新');
  if (!renames.size) return null;
  return {
    field_name: field.field_name,
    type: field.type,
    ...(field.ui_type ? { ui_type: field.ui_type } : {}),
    ...(field.description !== undefined ? { description: field.description } : {}),
    property: { ...field.property, options: options.map((option) => ({ ...option, name: renames.get(option.name) ?? option.name })) },
  };
}

module.exports = { storedCategory, canonicalCategory, planCategoryOptions };
