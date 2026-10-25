/**
 * 营养计算工具
 * 基础代谢率（BMR）与每日总能量消耗（TDEE）估算，
 * 采用 Mifflin-St Jeor 公式（国际通用、误差较小的静息代谢估算式）。
 */

/** 活动系数档位：供 UI 下拉与 calcTDEE 解析共用 */
export const ACTIVITY_LEVELS = [
  { key: 'sedentary', label: '久坐（基本不运动）', factor: 1.2 },
  { key: 'light', label: '轻度活动（每周运动1-3天）', factor: 1.375 },
  { key: 'moderate', label: '中度活动（每周运动3-5天）', factor: 1.55 },
  { key: 'intense', label: '重度活动（每周运动6-7天）', factor: 1.725 },
];

/**
 * 计算基础代谢率（Mifflin-St Jeor）：
 * 男：10×体重(kg) + 6.25×身高(cm) - 5×年龄 + 5
 * 女：10×体重(kg) + 6.25×身高(cm) - 5×年龄 - 161
 * @param {{gender: string, heightCm: number, weightKg: number, age?: number}} profile
 *        gender 支持 'male'/'female' 或 '男'/'女'；age 缺省按 30 岁
 * @returns {number} BMR（kcal/天，未取整）
 */
export function calcBMR(profile) {
  const { gender, heightCm, weightKg, age = 30 } = profile ?? {};
  const base =
    10 * Number(weightKg) + 6.25 * Number(heightCm) - 5 * Number(age);
  const isMale = gender === 'male' || gender === '男';
  return base + (isMale ? 5 : -161);
}

/**
 * 解析活动系数：支持档位 key（如 'light'）、直接传入的数值系数、
 * 或 ACTIVITY_LEVELS 中的对象；无法识别时回退为久坐 1.2。
 * @param {string|number|object} activity
 * @returns {number}
 */
function resolveActivityFactor(activity) {
  if (typeof activity === 'number' && activity > 0) return activity;
  if (activity && typeof activity === 'object' && typeof activity.factor === 'number') {
    return activity.factor;
  }
  const level = ACTIVITY_LEVELS.find((l) => l.key === activity);
  return level ? level.factor : 1.2;
}

/**
 * 计算每日总能量消耗 TDEE = BMR × 活动系数，四舍五入取整。
 * @param {{gender: string, heightCm: number, weightKg: number, age?: number, activity?: string|number|object}} profile
 * @returns {number} TDEE（kcal/天）
 */
export function calcTDEE(profile) {
  const factor = resolveActivityFactor(profile?.activity);
  return Math.round(calcBMR(profile) * factor);
}
