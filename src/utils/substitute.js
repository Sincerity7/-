/**
 * 套餐单品替换工具（Task 5）
 * 在已生成的套餐中，把某个单品换成"同类别、同餐段、热量相近、
 * 通过忌口过滤且替换后整套仍达标"的更优单品，并支持一键还原。
 */

import { filterSafe } from '../services/mcpClient.js';

/**
 * 汇总套餐各营养字段。
 * price：单品价格来自门店菜单匹配（未匹配单品为 null）。为避免"部分求和"
 * 冒充整套真实总价，仅当方案内全部单品均有价格时才输出总价，否则为 null；
 * 其余营养字段对非 null 数值求和并取整，若整列全为 null 则结果为 null。
 * @param {{meals: Array<{items: Array<object>}>}} plan 套餐
 * @returns {{calories: number|null, protein: number|null, carbs: number|null, fat: number|null, sodium: number|null, price: number|null}}
 */
export function sumPlan(plan) {
  const fields = ['calories', 'protein', 'carbs', 'fat', 'sodium', 'price'];
  const totals = {};
  for (const f of fields) {
    let hasValue = false;
    let allValue = true;
    let sum = 0;
    for (const meal of plan?.meals ?? []) {
      for (const item of meal.items ?? []) {
        const ok = typeof item[f] === 'number' && !Number.isNaN(item[f]);
        if (ok) {
          hasValue = true;
          sum += item[f];
        } else {
          allValue = false;
        }
      }
    }
    if (!hasValue) {
      totals[f] = null;
    } else if (f === 'price') {
      // 价格：整套全部单品齐备才算真实总价（保留两位小数），否则视为未公开
      totals[f] = allValue ? Math.round(sum * 100) / 100 : null;
    } else {
      totals[f] = Math.round(sum);
    }
  }
  return totals;
}

/** 深拷贝套餐（含 items 与已记录的还原信息），避免修改原对象 */
function clonePlan(plan) {
  return {
    ...plan,
    meals: (plan.meals ?? []).map((meal) => ({
      ...meal,
      items: (meal.items ?? []).map((item) => ({ ...item })),
    })),
    originalItems: plan.originalItems
      ? Object.fromEntries(
          Object.entries(plan.originalItems).map(([k, v]) => [k, { ...v }])
        )
      : undefined,
  };
}

/**
 * 为套餐中指定位置的单品寻找最优替换候选。
 * 候选条件：
 * 1. 与原子品同 category 且同 mealPeriod；
 * 2. 热量在原子品 ±10% 内；
 * 3. 通过 filterSafe（用户过敏原 + 自定义忌口）；
 * 4. 替换后整套总热量仍在 targetCalories ±5% 内。
 * 最优排序：高蛋白优先，其次低钠。
 * @param {{plan: object, mealIndex: number, itemIndex: number, items: Array<object>,
 *          allergens?: string[], customKeywords?: string[], targetCalories: number}} opts
 * @returns {object|null} 最优候选单品；无合规候选时返回 null
 */
export function findSubstitute(opts) {
  const { plan, mealIndex, itemIndex, items, allergens, customKeywords, targetCalories } = opts ?? {};
  const oldItem = plan?.meals?.[mealIndex]?.items?.[itemIndex];
  if (!oldItem || typeof oldItem.calories !== 'number') return null;
  if (typeof targetCalories !== 'number' || targetCalories <= 0) return null;

  const totals = plan.totals ?? sumPlan(plan);
  const totalMin = targetCalories * 0.95;
  const totalMax = targetCalories * 1.05;
  const calLo = oldItem.calories * 0.9;
  const calHi = oldItem.calories * 1.1;

  const safeItems = filterSafe(items ?? [], { allergens, customKeywords });
  const candidates = safeItems.filter((c) => {
    if (c.id === oldItem.id) return false;
    if (c.category !== oldItem.category) return false;
    if (c.mealPeriod !== oldItem.mealPeriod) return false;
    if (typeof c.calories !== 'number') return false;
    if (c.calories < calLo || c.calories > calHi) return false;
    // 替换后整套总热量仍需达标 ±5%
    const newTotal = (totals.calories ?? 0) - oldItem.calories + c.calories;
    return newTotal >= totalMin && newTotal <= totalMax;
  });

  if (candidates.length === 0) return null;
  // 高蛋白优先，同蛋白取低钠
  candidates.sort((a, b) => {
    const pa = a.protein ?? 0;
    const pb = b.protein ?? 0;
    if (pb !== pa) return pb - pa;
    return (a.sodium ?? 0) - (b.sodium ?? 0);
  });
  return candidates[0];
}

/**
 * 应用替换：返回新 plan（原 plan 不被修改），重算 totals，
 * 并在 plan.originalItems 中记录被替换单品的原对象以支持还原。
 * @param {object} plan 原套餐
 * @param {number} mealIndex 餐次下标
 * @param {number} itemIndex 该餐内单品下标
 * @param {object} newItem 替换后的单品
 * @returns {object} 新套餐
 */
export function applySubstitute(plan, mealIndex, itemIndex, newItem) {
  const next = clonePlan(plan);
  const oldItem = next.meals[mealIndex].items[itemIndex];
  next.originalItems = next.originalItems ?? {};
  // 记录原始单品（同一位置重复替换时保留最早的原品，便于彻底还原）
  const key = `${mealIndex}:${itemIndex}`;
  if (!next.originalItems[key]) next.originalItems[key] = { ...oldItem };
  next.meals[mealIndex].items[itemIndex] = { ...newItem };
  next.totals = sumPlan(next);
  return next;
}

/**
 * 还原：把 plan.originalItems 中记录的单品放回原位并重算 totals。
 * @param {object} plan 发生过替换的套餐
 * @returns {object} 还原后的新套餐（无替换记录时返回内容一致的副本）
 */
export function restoreOriginal(plan) {
  const next = clonePlan(plan);
  const records = next.originalItems ?? {};
  for (const [key, original] of Object.entries(records)) {
    const [mealIndex, itemIndex] = key.split(':').map(Number);
    if (next.meals[mealIndex]?.items?.[itemIndex]) {
      next.meals[mealIndex].items[itemIndex] = { ...original };
    }
  }
  next.originalItems = undefined;
  next.totals = sumPlan(next);
  return next;
}
