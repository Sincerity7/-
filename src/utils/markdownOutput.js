/**
 * Markdown 输出工具（Task 6）
 * 将套餐方案渲染为合法的 GitHub Markdown（marked 可直接渲染），
 * 供前端预览与复制导出使用。
 */

/** 策略展示名与场景标注 */
const STRATEGY_META = {
  lowcal: { name: '控卡优先', scene: '适合需要严格控制总热量、低钠饮食的日子' },
  value: { name: '性价比优先', scene: '适合精打细算的日子（门店菜单价格齐备时按整套总价最低，否则以每100kcal蛋白质为代理指标）' },
  satiety: { name: '饱腹感优先', scene: '适合运动量大或容易饿、需要更强饱腹感的日子' },
};

/** 餐段中文映射 */
const PERIOD_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

/** 数值格式化：null/undefined → "未公开"，否则原样 */
function fmt(value) {
  return value == null ? '未公开' : String(value);
}

/** 防止单元格内容破坏表格结构 */
function cell(text) {
  return String(text).replace(/\|/g, '\\|');
}

/**
 * 渲染单套方案为 Markdown。
 * 结构：标题（策略名+场景标注）→ 餐品清单表格 → `---` →
 * 总价 / 总热量 / 三大营养素（克数+供能比）→ 过敏原提示。
 * @param {{strategy: string, label?: string, meals: Array<{period: string, items: Array<object>}>, totals: object}} plan
 * @returns {string} GitHub Markdown 文本
 */
export function renderPlanMarkdown(plan) {
  const meta = STRATEGY_META[plan?.strategy] ?? { name: plan?.strategy ?? '自定义', scene: '' };
  const lines = [];
  lines.push(`# ${meta.name}方案 —— ${meta.scene}`);
  lines.push('');

  // 餐品清单表格
  lines.push('| 餐段 | 名称 | 价格 | 热量kcal | 蛋白g | 碳水g | 脂肪g | 钠mg |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const allItems = [];
  for (const meal of plan?.meals ?? []) {
    for (const item of meal.items ?? []) {
      allItems.push(item);
      lines.push(
        `| ${cell(PERIOD_LABEL[meal.period] ?? meal.period)} | ${cell(item.name)} | ` +
          `${cell(fmt(item.price))} | ${cell(fmt(item.calories))} | ${cell(fmt(item.protein))} | ` +
          `${cell(fmt(item.carbs))} | ${cell(fmt(item.fat))} | ${cell(fmt(item.sodium))} |`
      );
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  const totals = plan?.totals ?? {};
  // 整套总价
  lines.push(
    totals.price == null
      ? '**整套总价：** 未公开（门店菜单未收录本方案全部单品价格）'
      : `**整套总价：** ¥${totals.price}（上海徐家汇餐厅在售菜单 currentPrice 合计）`
  );
  // 整套总热量
  lines.push('');
  lines.push(`**整套总热量：** ${fmt(totals.calories)} kcal`);
  lines.push('');

  // 三大营养素汇总：克数 + 供能比（蛋白4 / 碳水4 / 脂肪9 kcal/g）
  const p = totals.protein ?? 0;
  const c = totals.carbs ?? 0;
  const f = totals.fat ?? 0;
  const pCal = p * 4;
  const cCal = c * 4;
  const fCal = f * 9;
  const macroSum = pCal + cCal + fCal;
  const pct = (v) => (macroSum > 0 ? `${Math.round((v / macroSum) * 1000) / 10}%` : '—');
  lines.push('**三大营养素汇总：**');
  lines.push('');
  lines.push('| 营养素 | 克数 | 供能比 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 蛋白质 | ${fmt(totals.protein)} g | ${pct(pCal)} |`);
  lines.push(`| 碳水 | ${fmt(totals.carbs)} g | ${pct(cCal)} |`);
  lines.push(`| 脂肪 | ${fmt(totals.fat)} g | ${pct(fCal)} |`);
  lines.push('');

  // 过敏原提示
  const inferred = allItems.some((it) => it.allergens != null && it.allergenBasis != null);
  const unknown = allItems.filter((it) => it.allergenUnknown || it.allergens == null);
  if (inferred) {
    lines.push('> 注：本方案中的过敏原为推断数据，非官方声明。');
    lines.push('');
  }
  if (unknown.length > 0) {
    const names = [...new Set(unknown.map((it) => it.name))].join('、');
    lines.push(`> ⚠️ 以下单品过敏原未知，请自行确认：${names}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 渲染三套方案横向对比 Markdown 表格。
 * 列：方案 | 场景 | 总热量 | 蛋白质 | 碳水 | 脂肪 | 钠 | 总价。
 * @param {Array<object>} plans 方案数组（通常 3 套）
 * @returns {string} GitHub Markdown 文本
 */
export function renderComparisonMarkdown(plans) {
  const lines = [];
  lines.push('# 三套方案对比');
  lines.push('');
  lines.push('| 方案 | 场景 | 总热量 | 蛋白质 | 碳水 | 脂肪 | 钠 | 总价 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const plan of plans ?? []) {
    const meta = STRATEGY_META[plan?.strategy] ?? { name: plan?.strategy ?? '—', scene: '—' };
    const t = plan?.totals ?? {};
    lines.push(
      `| ${cell(meta.name)} | ${cell(meta.scene)} | ${cell(fmt(t.calories))} kcal | ` +
        `${cell(fmt(t.protein))} g | ${cell(fmt(t.carbs))} g | ${cell(fmt(t.fat))} g | ` +
        `${cell(fmt(t.sodium))} mg | ${t.price == null ? '未公开' : `¥${t.price}`} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}
