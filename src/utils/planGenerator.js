/**
 * 减脂套餐生成器（Task 4）
 *
 * 输入：菜单单品 + 每日目标热量 + 用户忌口，输出三套策略各异的三餐方案。
 *
 * 规则：
 * - 三餐热量配额：早 30% / 午 40% / 晚 30%，每餐允许 ±15% 浮动；
 * - 整套总热量必须落在目标 ±5%，绝不输出超标方案；
 * - 每餐构成：1 个主食 + 0~2 个配菜（小食/饮品/麦咖啡/甜品）用于微调热量；
 *   早餐主食取自 breakfast 餐段"早餐"分类中的堡/卷/麦满分；
 *   午晚主食取自"汉堡和卷"分类；开心乐园餐不作为成人套餐候选；
 * - 三套策略相互独立（不要求互斥单品），同达标条件优先高蛋白低钠。
 *
 * 性能：先为每餐枚举"主食+0~2配菜"组合并按热量窗口过滤、
 * 按多维指标截断（剪枝），再对 早×午 组合二分查找晚餐候选，
 * 一次遍历同时为三个策略择优，浏览器端 <500ms 量级。
 */

import { filterSafe } from '../services/mcpClient.js';
import { sumPlan } from './substitute.js';

/** 三个策略的元信息：id、展示标签 */
export const STRATEGIES = {
  lowcal: {
    strategy: 'lowcal',
    label: '控卡优先 · 总热量贴近目标95%且钠最低',
  },
  value: {
    strategy: 'value',
    label: '性价比优先 · 价格齐备按整套总价最低，否则每100kcal蛋白质最高（代理指标）',
  },
  satiety: {
    strategy: 'satiety',
    label: '饱腹感优先 · 蛋白+脂肪克数（总克重代理）最高',
  },
};

// 每餐热量配额与浮动比例
const MEAL_QUOTAS = [
  { period: 'breakfast', quota: 0.3 },
  { period: 'lunch', quota: 0.4 },
  { period: 'dinner', quota: 0.3 },
];
const MEAL_FLOAT = 0.15; // 每餐 ±15%
const TOTAL_FLOAT = 0.05; // 整套 ±5%
// 每个主食保留的配菜组合数上限（按多维指标各取前 3 后去重，最多 12）
const COMBOS_PER_STAPLE = 12;

/** 早餐主食判定：名称含"堡/卷/麦满分" */
function isBreakfastStaple(name) {
  return /堡|卷|麦满分/.test(String(name ?? ''));
}

/** 配菜分类池（全天供应，且排除主食分类与开心乐园餐） */
const SIDE_CATEGORIES = ['小食', '饮品', '麦咖啡', '甜品'];

/**
 * 为一餐构建候选组合：主食 + 0~2 个配菜，热量在 [lo, hi] 窗口内。
 * 对每个主食按四个维度各取前 3 名去重截断，兼顾三套策略的择优需求。
 * @returns {Array<{items: Array<object>, calories: number, protein: number, carbs: number, fat: number, sodium: number}>}
 */
function buildMealCandidates(staples, sidePool, lo, hi) {
  const out = [];
  for (const staple of staples) {
    const combos = [];
    const pushCombo = (sides) => {
      let cal = staple.calories;
      let protein = staple.protein ?? 0;
      let carbs = staple.carbs ?? 0;
      let fat = staple.fat ?? 0;
      let sodium = staple.sodium ?? 0;
      // 组合价：主食+全部配菜均有真实价格才有效，否则 null（性价比策略回退代理指标）
      let price = typeof staple.price === 'number' ? staple.price : null;
      for (const s of sides) {
        cal += s.calories;
        protein += s.protein ?? 0;
        carbs += s.carbs ?? 0;
        fat += s.fat ?? 0;
        sodium += s.sodium ?? 0;
        price = typeof s.price === 'number' && price != null ? price + s.price : null;
      }
      if (cal < lo || cal > hi) return;
      combos.push({
        items: [staple, ...sides],
        calories: cal,
        protein,
        carbs,
        fat,
        sodium,
        price: price == null ? null : Math.round(price * 100) / 100,
      });
    };

    pushCombo([]);
    for (let i = 0; i < sidePool.length; i++) {
      pushCombo([sidePool[i]]);
      for (let j = i + 1; j < sidePool.length; j++) {
        pushCombo([sidePool[i], sidePool[j]]);
      }
    }
    if (combos.length === 0) continue;

    const center = (lo + hi) / 2;
    const by = (cmp) => [...combos].sort(cmp).slice(0, 3);
    // 四个维度各取前 3：蛋白密度、低钠、饱腹（蛋白+脂肪）、贴近配额中心
    const picks = [
      ...by((a, b) => b.protein / b.calories - a.protein / a.calories),
      ...by((a, b) => a.sodium - b.sodium),
      ...by((a, b) => b.protein + b.fat - (a.protein + a.fat)),
      ...by((a, b) => Math.abs(a.calories - center) - Math.abs(b.calories - center)),
    ];
    const seen = new Set();
    for (const c of picks) {
      const key = c.items.map((it) => it.id).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
      if (seen.size >= COMBOS_PER_STAPLE) break;
    }
  }
  return out;
}

/** 在按热量升序排列的候选数组中二分查找第一个 cal >= value 的下标 */
function lowerBoundByCal(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].calories < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 生成三套策略方案。
 * @param {{items: Array<object>, targetCalories: number, allergens?: string[], customKeywords?: string[]}} opts
 * @returns {{plans: Array<object>, error?: string}}
 *   成功：plans 为 3 套方案，每套 {strategy, label, meals:[{period, items}], totals}；
 *   无解：plans 为空数组且 error 为提示文案，绝不返回超标方案。
 */
export function generatePlans(opts) {
  const { items, targetCalories, allergens = [], customKeywords = [] } = opts ?? {};
  const noSolution = {
    plans: [],
    error: '当前忌口条件下无法凑出达标套餐，建议放宽过敏原/忌口或提高每日热量上限',
  };
  if (!Array.isArray(items) || typeof targetCalories !== 'number' || targetCalories <= 0) {
    return noSolution;
  }

  // 1) 忌口过滤 + 基础清洗（剔除热量缺失单品与儿童套餐）
  const usable = filterSafe(items, { allergens, customKeywords }).filter(
    (it) =>
      typeof it.calories === 'number' &&
      !Number.isNaN(it.calories) &&
      it.category !== '开心乐园餐'
  );

  const breakfastStaples = usable.filter(
    (it) => it.mealPeriod === 'breakfast' && it.category === '早餐' && isBreakfastStaple(it.name)
  );
  const burgerStaples = usable.filter(
    (it) => it.mealPeriod === 'allDay' && it.category === '汉堡和卷'
  );
  const sidePool = usable.filter(
    (it) => it.mealPeriod === 'allDay' && SIDE_CATEGORIES.includes(it.category)
  );

  // 2) 逐餐构建候选组合（含剪枝截断）
  const mealWindows = MEAL_QUOTAS.map((m) => {
    const q = targetCalories * m.quota;
    return { period: m.period, lo: q * (1 - MEAL_FLOAT), hi: q * (1 + MEAL_FLOAT) };
  });
  const pools = [
    { staples: breakfastStaples, sides: sidePool },
    { staples: burgerStaples, sides: sidePool },
    { staples: burgerStaples, sides: sidePool },
  ];
  const mealCands = mealWindows.map((w, i) =>
    buildMealCandidates(pools[i].staples, pools[i].sides, w.lo, w.hi)
  );
  if (mealCands.some((c) => c.length === 0)) return noSolution;

  // 3) 早×午 枚举 + 晚餐二分匹配，一次遍历为三个策略择优
  const totalMin = targetCalories * (1 - TOTAL_FLOAT);
  const totalMax = targetCalories * (1 + TOTAL_FLOAT);
  const dinnerSorted = [...mealCands[2]].sort((a, b) => a.calories - b.calories);

  // 各策略当前最优：best = {combo, score}；tie 时高蛋白低钠
  const best = { lowcal: null, value: null, satiety: null };

  const betterThan = (strategy, cand, cur) => {
    if (!cur) return true;
    if (strategy === 'lowcal') {
      const gap = Math.abs(cand.calories - targetCalories * 0.95);
      const curGap = Math.abs(cur.calories - targetCalories * 0.95);
      if (gap !== curGap) return gap < curGap;
    } else if (strategy === 'value') {
      // 真实价格优先：双方三餐价格齐备 → 整套总价最低；仅一方齐备 → 齐备方优先；
      // 均不齐备 → 回退"每100kcal蛋白质"代理指标（保持既有测试语义）
      const candPriced = cand.price != null;
      const curPriced = cur.price != null;
      if (candPriced && curPriced) {
        if (cand.price !== cur.price) return cand.price < cur.price;
      } else if (candPriced !== curPriced) {
        return candPriced;
      } else {
        const dens = cand.protein / cand.calories;
        const curDens = cur.protein / cur.calories;
        if (dens !== curDens) return dens > curDens;
      }
    } else {
      const sat = cand.protein + cand.fat;
      const curSat = cur.protein + cur.fat;
      if (sat !== curSat) return sat > curSat;
    }
    // 同分：高蛋白优先，再低钠
    if (cand.protein !== cur.protein) return cand.protein > cur.protein;
    return cand.sodium < cur.sodium;
  };

  const consider = (merged) => {
    for (const s of ['lowcal', 'value', 'satiety']) {
      if (betterThan(s, merged, best[s])) best[s] = merged;
    }
  };

  const merge = (b, l, d) => ({
    cands: [b, l, d],
    calories: b.calories + l.calories + d.calories,
    protein: b.protein + l.protein + d.protein,
    carbs: b.carbs + l.carbs + d.carbs,
    fat: b.fat + l.fat + d.fat,
    sodium: b.sodium + l.sodium + d.sodium,
    // 整套价格：三餐组合价全部齐备才有效（保留两位小数），否则 null
    price:
      b.price != null && l.price != null && d.price != null
        ? Math.round((b.price + l.price + d.price) * 100) / 100
        : null,
  });

  for (const b of mealCands[0]) {
    for (const l of mealCands[1]) {
      const sum2 = b.calories + l.calories;
      const dLo = totalMin - sum2;
      const dHi = totalMax - sum2;
      if (dHi < dinnerSorted[0].calories || dLo > dinnerSorted[dinnerSorted.length - 1].calories) {
        continue;
      }
      let idx = lowerBoundByCal(dinnerSorted, Math.max(dLo, dinnerSorted[0].calories));
      for (; idx < dinnerSorted.length && dinnerSorted[idx].calories <= dHi; idx++) {
        const merged = merge(b, l, dinnerSorted[idx]);
        if (merged.calories >= totalMin && merged.calories <= totalMax) consider(merged);
      }
    }
  }

  if (!best.lowcal || !best.value || !best.satiety) return noSolution;

  // 4) 组装输出方案（三套相互独立）
  const plans = ['lowcal', 'value', 'satiety'].map((s) => {
    const meals = best[s].cands.map((cand, i) => ({
      period: mealWindows[i].period,
      items: cand.items.map((it) => ({ ...it })),
    }));
    const plan = { strategy: s, label: STRATEGIES[s].label, meals };
    plan.totals = sumPlan(plan);
    return plan;
  });

  return { plans };
}
