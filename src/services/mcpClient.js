/**
 * 麦当劳菜单数据访问层（MCP 客户端封装）
 *
 * 当前实现读取内置的官网公开数据快照（src/data/mcdonalds-menu.json）。
 * 未来接入真实"麦当劳 MCP"时，只需替换 getMenu() 的内部实现
 * （改为调用 MCP 工具并把返回数据整理成同样的 {meta, items} 结构），
 * 上层调用方（套餐生成 / 单品替换 / Markdown 导出）零改动。
 */

// 内置快照导入：使用 JSON import 属性，Vite 与 Node ESM 均可解析
import snapshot from '../data/mcdonalds-menu.json' with { type: 'json' };

// 模块级缓存：一次会话内只准备一份菜单数据副本
let menuCache = null;

/**
 * 获取完整菜单。
 * @returns {Promise<{meta: object, items: Array<object>}>} 菜单元信息与单品列表
 */
export async function getMenu() {
  if (!menuCache) {
    // 复制一层，避免调用方修改缓存内部数据
    menuCache = {
      meta: snapshot.meta,
      items: snapshot.items.map((item) => ({ ...item })),
    };
  }
  return menuCache;
}

/**
 * 按名称模糊搜索单品（大小写不敏感的子串匹配）。
 * @param {string} keyword 关键词
 * @returns {Array<object>} 命中的单品列表；关键词为空时返回全部
 */
export function searchItems(keyword) {
  const items = menuCache ? menuCache.items : snapshot.items;
  const kw = String(keyword ?? '').trim().toLowerCase();
  if (!kw) return items.map((item) => ({ ...item }));
  return items
    .filter((item) => String(item.name ?? '').toLowerCase().includes(kw))
    .map((item) => ({ ...item }));
}

/**
 * 忌口安全过滤：
 * 1. 剔除 allergens 数组命中用户任一过敏原的单品（精确匹配过敏原名称）；
 * 2. customKeywords（自定义忌口词）命中餐品名称的单品同样剔除；
 * 3. allergens 为 null（官网/快照未声明）的单品保留，并附加 allergenUnknown: true 标记。
 * @param {Array<object>} items 待过滤单品
 * @param {{allergens?: string[], customKeywords?: string[]}} [options] 用户过敏原与自定义忌口词
 * @returns {Array<object>} 过滤后的单品副本列表（保留 allergenUnknown 标记）
 */
export function filterSafe(items, options = {}) {
  const userAllergens = new Set(
    (options.allergens ?? []).map((a) => String(a).trim()).filter(Boolean)
  );
  const keywords = (options.customKeywords ?? [])
    .map((k) => String(k).trim())
    .filter(Boolean);

  const result = [];
  for (const item of items ?? []) {
    // 过敏原命中：官方声明的过敏原数组与用户过敏原集合有交集即剔除
    if (Array.isArray(item.allergens) && userAllergens.size > 0) {
      const hit = item.allergens.some((a) => userAllergens.has(String(a).trim()));
      if (hit) continue;
    }
    // 自定义忌口：按餐品名称子串匹配
    if (keywords.some((kw) => String(item.name ?? '').includes(kw))) continue;

    const copy = { ...item };
    if (item.allergens == null) copy.allergenUnknown = true;
    result.push(copy);
  }
  return result;
}

/**
 * 按餐段筛选单品。
 * @param {Array<object>} items 单品列表
 * @param {'breakfast'|'lunch'|'dinner'} period 餐段；lunch/dinner 取全天供应（allDay）单品
 * @returns {Array<object>} 该餐段可售单品
 */
export function byMealPeriod(items, period) {
  const want = period === 'breakfast' ? 'breakfast' : 'allDay';
  return (items ?? []).filter((item) => item.mealPeriod === want);
}
