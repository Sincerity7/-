/**
 * 麦当劳 MCP 官方营养数据拉取脚本（构建期数据源）
 *
 * 作用：调用麦当劳 MCP 的 list-nutrition-foods 工具，拉取 160 个单品的
 * 官方营养数据，映射为本应用菜单快照 schema 后写入
 * src/data/mcdonalds-menu.json（旧官网快照自动备份一次）。
 *
 * 同时调用 query-nearby-stores + query-meals 拉取上海徐家汇餐厅（storeCode 1450034）
 * 的在售菜单现价，按名称规范化匹配为 160 个营养单品填价（宁缺勿滥，未命中保持 null）。
 *
 * 用法：
 *   node scripts/fetch-mcp-data.mjs                        # 在线拉取（Token 从 .env 读取）
 *   node scripts/fetch-mcp-data.mjs --offline              # 离线解析上次调用的缓存响应
 *   node scripts/fetch-mcp-data.mjs --meals-cache <path>   # 价格步骤离线回退：读取 query-meals 缓存响应
 *
 * 安全红线：Token 只在运行时从 .env 解析，绝不打印/写入任何输出与产物。
 * 幂等性：同一数据源重复执行产出内容一致（仅 fetchedAt 随日期变化）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ENV_FILE = path.join(ROOT, '.env')
const DATA_FILE = path.join(ROOT, 'src', 'data', 'mcdonalds-menu.json')
const BACKUP_FILE = path.join(ROOT, 'src', 'data', 'mcdonalds-menu.website-backup.json')
// 上次真实调用的原始响应缓存（离线模式使用）：
// 依次尝试 LOCALAPPDATA\Temp、用户主目录 AppData\Local\Temp、系统 TEMP
function resolveCacheFile() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Temp', 'mcd-nutrition.json'),
    path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'mcd-nutrition.json'),
    process.env.TEMP && path.join(process.env.TEMP, 'mcd-nutrition.json'),
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  return candidates[0] ?? 'mcd-nutrition.json'
}
const CACHE_FILE = resolveCacheFile()

/* ============================================================
   0. 基础工具
   ============================================================ */

/** 从 .env 解析键值（跳过注释与空行；值中不打印、不持久化） */
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) throw new Error('缺少 .env 文件（应包含 MCD_MCP_URL / MCD_MCP_TOKEN）')
  const out = {}
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

/** 本地日期 YYYY-MM-DD（Asia/Shanghai 口径） */
function todayLocal() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 名称规范化：去掉所有空白，用于跨数据源按名称匹配 */
const normalize = (s) => String(s ?? '').replace(/\s+/g, '')

/** 去掉规格后缀/前缀（杯型、块数、括号备注），用于宽松名称匹配 */
function stripSpec(s) {
  return normalize(s)
    .replace(/^(大杯|中杯|小杯)/, '')
    .replace(/(大杯|中杯|小杯)$/, '')
    .replace(/-?\d+块$/, '')
    .replace(/[（(][^（）()]*[)）]$/, '')
}

/** 字符串转数值：'null'/空 → null，其余 Number（NaN → null） */
function num(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (s === '' || s === 'null') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/* ============================================================
   1. 拉取 / 缓存读取：得到 MCP 返回中的紧凑表格串 data
   ============================================================ */

/** 通用 MCP tools/call 调用：返回解析后的 JSON-RPC payload（Token 仅进请求头，绝不输出） */
async function callMcpTool(env, toolName, args, id) {
  const url = env.MCD_MCP_URL
  const token = env.MCD_MCP_TOKEN
  if (!url || !token) throw new Error('.env 中缺少 MCD_MCP_URL 或 MCD_MCP_TOKEN')

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`, // 仅用于请求头，绝不输出
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args ?? {} },
    }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}（Token 校验/限流请检查开放平台）`)

  const raw = await res.text()
  // 兼容 application/json 与 text/event-stream 两种响应形态
  if (raw.trimStart().startsWith('{')) return JSON.parse(raw)
  const dataLines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'))
  if (dataLines.length === 0) throw new Error('MCP 响应无法解析（既非 JSON 也非 SSE）')
  return JSON.parse(dataLines[dataLines.length - 1].slice(5).trim())
}

/** 在线调用 list-nutrition-foods，返回 data 字符串 */
async function fetchOnline() {
  const payload = await callMcpTool(loadEnv(), 'list-nutrition-foods', {}, 3)
  if (payload.error) throw new Error(`MCP JSON-RPC 错误：${payload.error.code} ${payload.error.message}`)
  return extractDataString(payload)
}

/** 离线模式：读取上次调用的原始响应缓存 */
function fetchOffline() {
  if (!fs.existsSync(CACHE_FILE)) throw new Error(`离线缓存不存在：${CACHE_FILE}`)
  // 缓存文件可能带 BOM
  const payload = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8').replace(/^\uFEFF/, ''))
  return extractDataString(payload)
}

/**
 * 从 JSON-RPC 响应中提取紧凑表格串 data：
 * 优先 result.structuredContent.data；否则从 content[0].text 的
 * "Original Response" 段中解析内嵌 JSON 的 data 字段。
 */
function extractDataString(payload) {
  const result = payload?.result
  if (!result) throw new Error('MCP 响应缺少 result 字段')
  if (result.structuredContent?.data) return result.structuredContent.data
  const text = result.content?.find((c) => c?.type === 'text')?.text
  if (!text) throw new Error('MCP 响应缺少文本内容')
  const m = text.match(/## Original Response\s*([\s\S]*)$/)
  if (!m) throw new Error('响应文本中未找到 Original Response 段')
  const inner = JSON.parse(m[1].trim())
  if (!inner?.data) throw new Error('Original Response 中缺少 data 字段')
  return inner.data
}

/* ============================================================
   1b. 价格链路：query-nearby-stores → query-meals → 名称匹配填价
   ------------------------------------------------------------
   门店逻辑：查上海徐家汇附近门店，优先 24 小时营业（00:00-23:59）的
   麦当劳上海徐家汇餐厅 storeCode=1450034；失败（如打烊报 600057
   "不在营业时间"）则换 1450002（静安寺），再兜底列表中任一门店。
   --meals-cache <path> 为离线回退：直接读取上次成功的 query-meals 响应。
   ============================================================ */

/** 价格来源门店（写入 meta.note 与日志，便于口径追溯） */
const PRICE_STORES = [
  { storeCode: '1450034', label: '麦当劳上海徐家汇餐厅（24小时）' },
  { storeCode: '1450002', label: '麦当劳静安寺餐厅（备选）' },
]

/** 从 JSON-RPC payload 中提取业务 data 对象（structuredContent.data 优先，否则 Original Response 内嵌 JSON） */
function extractDataObject(payload) {
  const result = payload?.result
  if (!result) throw new Error('MCP 响应缺少 result 字段')
  if (result.structuredContent?.data) return result.structuredContent.data
  const text = result.content?.find((c) => c?.type === 'text')?.text
  if (!text) throw new Error('MCP 响应缺少文本内容')
  const m = text.match(/## Original Response\s*([\s\S]*)$/)
  if (!m) throw new Error('响应文本中未找到 Original Response 段')
  const inner = JSON.parse(m[1].trim())
  if (!inner?.data) throw new Error('Original Response 中缺少 data 字段')
  return inner.data
}

/** 判断一次 tools/call 是否业务失败（JSON-RPC error / result.isError / 内层 success=false） */
function isBusinessFailure(payload) {
  if (payload?.error) return `${payload.error.code ?? ''} ${payload.error.message ?? ''}`.trim()
  if (payload?.result?.isError) {
    const text = payload.result.content?.find((c) => c?.type === 'text')?.text ?? ''
    return text.slice(0, 120) || 'isError'
  }
  const text = payload?.result?.content?.find((c) => c?.type === 'text')?.text ?? ''
  const m = text.match(/## Original Response\s*([\s\S]*)$/)
  if (m) {
    try {
      const inner = JSON.parse(m[1].trim())
      if (inner?.success === false) return `${inner.code ?? ''} ${inner.message ?? ''}`.trim()
    } catch { /* 内层非 JSON 则视为成功，交由后续结构解析报错 */ }
  }
  return null
}

/** 深度遍历查找门店数组：元素为含 storeCode 字段的对象 */
function findStoreArray(node, depth = 0) {
  if (depth > 6 || node == null) return null
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every((x) => x && typeof x === 'object' && x.storeCode != null)) return node
    for (const x of node) {
      const r = findStoreArray(x, depth + 1)
      if (r) return r
    }
    return null
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) {
      const r = findStoreArray(v, depth + 1)
      if (r) return r
    }
  }
  return null
}

/** 从 query-nearby-stores 响应中按优先级挑选候选门店（storeCode 列表） */
function pickStoreCandidates(payload) {
  const data = extractDataObject(payload)
  const stores = findStoreArray(data) ?? []
  const byCode = new Map(stores.map((s) => [String(s.storeCode), s]))
  const is24h = (s) => {
    const j = JSON.stringify(s ?? {})
    return /00:00/.test(j) && /23:59/.test(j)
  }
  const ordered = []
  // 1) 优先目标门店（1450034 → 1450002）；2) 列表中任一 24 小时门店；3) 其余门店
  for (const { storeCode } of PRICE_STORES) if (byCode.has(storeCode)) ordered.push(storeCode)
  for (const s of stores) if (is24h(s) && !ordered.includes(String(s.storeCode))) ordered.push(String(s.storeCode))
  for (const s of stores) if (!ordered.includes(String(s.storeCode))) ordered.push(String(s.storeCode))
  return ordered
}

/** 在线拉取门店在售菜单：query-nearby-stores 选店 → query-meals，返回 [{code,name,price}] */
async function fetchMealsOnline() {
  const env = loadEnv()
  const near = await callMcpTool(env, 'query-nearby-stores',
    { beType: 1, searchType: 2, city: '上海', keyword: '徐家汇' }, 7)
  const nearFail = isBusinessFailure(near)
  if (nearFail) throw new Error(`query-nearby-stores 失败：${nearFail}`)
  const candidates = pickStoreCandidates(near)
  if (candidates.length === 0) throw new Error('query-nearby-stores 未返回可用门店')

  let lastFail = ''
  for (const storeCode of candidates) {
    const mealsPayload = await callMcpTool(env, 'query-meals',
      { storeCode, orderType: 1, beType: 1 }, 8)
    const fail = isBusinessFailure(mealsPayload)
    if (fail) {
      // 常见 600057"不在营业时间"：换下一候选门店重试
      lastFail = `storeCode=${storeCode}：${fail}`
      console.warn(`⚠️ query-meals ${lastFail}，尝试下一门店`)
      continue
    }
    const meals = extractMealsMap(mealsPayload)
    if (meals.length === 0) {
      lastFail = `storeCode=${storeCode}：菜单为空`
      continue
    }
    const label = PRICE_STORES.find((s) => s.storeCode === storeCode)?.label ?? `storeCode=${storeCode}`
    console.log(`▶ 价格来源门店：${label}，在售菜单 ${meals.length} 条`)
    return { meals, storeCode }
  }
  throw new Error(`所有候选门店 query-meals 均失败（最后：${lastFail}）`)
}

/** 离线回退：读取 query-meals 成功响应缓存（UTF-8 BOM 容忍） */
function fetchMealsFromCache(cachePath) {
  if (!fs.existsSync(cachePath)) throw new Error(`价格缓存不存在：${cachePath}`)
  const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8').replace(/^\uFEFF/, ''))
  const meals = extractMealsMap(payload)
  if (meals.length === 0) throw new Error(`价格缓存中未解析到在售菜单：${cachePath}`)
  console.log(`▶ 价格来源：query-meals 缓存 ${cachePath}（在售菜单 ${meals.length} 条，门店 1450034）`)
  return { meals, storeCode: '1450034' }
}

/** 从 query-meals payload 提取 code→{name,currentPrice} 列表（价格不可解析的条目丢弃） */
function extractMealsMap(payload) {
  const data = extractDataObject(payload)
  const map = data?.meals
  if (!map || typeof map !== 'object') throw new Error('query-meals 响应缺少 data.meals 映射')
  const out = []
  for (const [code, m] of Object.entries(map)) {
    if (!m || typeof m.name !== 'string') continue
    const price = num(m.currentPrice)
    if (price == null) continue
    out.push({ code, name: m.name, price })
  }
  return out
}

/**
 * 菜单名规范化：去空白、【】及其内容、括号备注、™/引号、块数与杯型规格词。
 * 返回 { base, blocks }：blocks 为"N块"规格数字（无则 null），
 * 用于区分 麦乐鸡4块/5块 这类同名不同规格的单品。
 */
function canonicalizeMealName(raw) {
  let s = normalize(raw)
  s = s.replace(/【[^】]*】/g, '') // 【美汁源】等品牌前缀
  s = s.replace(/[（(][^（）()]*[)）]/g, '') // (盒装)(冰/热) 等括号备注
  s = s.replace(/[™®“”"']/g, '') // 商标符号与中英文引号
  const blocksMatch = s.match(/(\d+)块/) // 麦乐鸡5块 / 4块麦乐鸡 / 麦辣鸡翅-2块
  const blocks = blocksMatch ? Number(blocksMatch[1]) : null
  s = s.replace(/\d+块/g, '')
  s = s.replace(/大杯|中杯|小杯/g, '') // 杯型规格
  s = s.replace(/^(大|中|小)(?=薯条)/, '') // 中/大/小薯条 → 薯条（门店菜单只列"薯条"）
  s = s.replace(/^-+|-+$/g, '') // 残留连字符（麦辣鸡翅-2块 → 麦辣鸡翅）
  return { base: s, blocks }
}

/**
 * 营养单品 ↔ 门店菜单匹配填价（宁缺勿滥）：
 * 三个匹配档（高档优先，档内候选必须唯一才命中）：
 *   T1 base 全等且块数一致；
 *   T2 base 全等，仅一侧带"N块"规格（如 菜单"麦乐鸡" ↔ 营养"麦乐鸡5块"）；
 *   T3 base 双向包含且长度差 ≤1，块数兼容（如 "热牛奶" ↔ "牛奶"）。
 * 命中 → price=currentPrice（数值）；未命中保持 null（界面显示"未公开"）。
 * @returns {{count: number, examples: Array<object>}}
 */
function applyPrices(items, meals) {
  const menu = meals.map((m) => ({ ...m, ...canonicalizeMealName(m.name) }))
  let count = 0
  const examples = []
  for (const it of items) {
    const { base, blocks } = canonicalizeMealName(it.name)
    if (!base) continue
    const t1 = []
    const t2 = []
    const t3 = []
    for (const m of menu) {
      if (!m.base) continue
      const blocksOk = blocks == null || m.blocks == null || blocks === m.blocks
      if (base === m.base) {
        if (blocks === m.blocks) t1.push(m)
        else if (blocksOk) t2.push(m)
      } else if (blocksOk) {
        const diff = Math.abs(base.length - m.base.length)
        if (diff <= 1 && (base.includes(m.base) || m.base.includes(base))) t3.push(m)
      }
    }
    const hit = [t1, t2, t3].find((tier) => tier.length === 1)
    if (!hit) continue // 无候选或多候选歧义 → 宁缺勿滥，保持 null
    it.price = hit[0].price
    count++
    examples.push({ name: it.name, menuName: hit[0].name, price: hit[0].price })
  }
  const rate = items.length ? Math.round((count / items.length) * 1000) / 10 : 0
  console.log(`\n【价格匹配】营养 ${items.length} 条 ↔ 门店菜单 ${meals.length} 条，命中 ${count} 条（命中率 ${rate}%，未命中保持 null）`)
  console.log('  命中示例（前 10 条）：')
  for (const e of examples.slice(0, 10)) {
    console.log(`  · ${e.name} ←「${e.menuName}」 ¥${e.price}`)
  }
  return { count, rate, examples }
}

/**
 * 解析紧凑表格串：
 *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *   名称,null,1288,308,16,16,24,781,213
 * 行以两个空格缩进开始、逗号分隔 9 列；名称可含空格，
 * 若某行列数 > 9（描述含逗号），把中间多余列合并回 nutritionDescription。
 */
function parseTable(dataStr) {
  const lines = dataStr.split('\n')
  const header = lines[0].match(/^\[(\d+)\]\{(.*)\}:$/)
  if (!header) throw new Error(`表格头解析失败：${lines[0]?.slice(0, 60)}`)
  const declared = Number(header[1])
  const rows = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const parts = line.trim().split(',')
    if (parts.length < 9) {
      console.warn(`⚠️ 跳过异常行（列数 ${parts.length}）：${line.slice(0, 50)}`)
      continue
    }
    const name = parts[0].trim()
    const desc = parts.slice(1, parts.length - 7).join(',')
    const tail = parts.slice(parts.length - 7) // energyKj..calcium 共 7 列
    rows.push({
      name,
      desc,
      energyKj: num(tail[0]),
      energyKcal: num(tail[1]),
      protein: num(tail[2]),
      fat: num(tail[3]),
      carbohydrate: num(tail[4]),
      sodium: num(tail[5]),
      calcium: num(tail[6]),
    })
  }
  if (rows.length !== declared) {
    console.warn(`⚠️ 声明 ${declared} 条，实际解析 ${rows.length} 条`)
  }
  return rows
}

/* ============================================================
   2. 分类 / 餐段映射（对齐 planGenerator 的硬性要求）
   ------------------------------------------------------------
   生成器要求：
   - 早餐主食：mealPeriod==='breakfast' 且 category==='早餐' 且名称含 堡/卷/麦满分；
   - 午晚主食：category==='汉堡和卷' 且 mealPeriod==='allDay'；
   - 配菜池：category ∈ {小食,饮品,麦咖啡,甜品} 且 allDay；
   - 开心乐园餐不作为成人套餐候选。
   规则按 MCP 名称关键词映射到既有分类枚举，顺序即优先级。
   ============================================================ */

function mapCategory(name) {
  const n = normalize(name)
  // 儿童/开心乐园单品 → 开心乐园餐（生成器自动排除，避免儿童套餐混入成人方案）
  if (/儿童|开心乐园/.test(n)) return { category: '开心乐园餐', mealPeriod: 'allDay' }
  // 早餐餐段：麦满分/粥/油条/薯饼/早安营养卷/图林根香肠/炒双蛋堡（早餐堡）
  if (/麦满分|粥|油条|薯饼|早安营养卷|图林根|炒双蛋堡/.test(n))
    return { category: '早餐', mealPeriod: 'breakfast' }
  // 全天主食：堡/卷 + 经典命名（麦香鸡/麦香鱼/巨无霸 名称不含"堡"）
  if (/堡|卷|麦香鸡|麦香鱼|巨无霸/.test(n)) return { category: '汉堡和卷', mealPeriod: 'allDay' }
  // 甜品：新地/冰淇淋/麦旋风/圆筒/派/拉明顿/奶冻/爆珠
  if (/新地|冰淇淋|麦旋风|圆筒|派$|拉明顿|奶冻|爆珠/.test(n))
    return { category: '甜品', mealPeriod: 'allDay' }
  // 盒装纯牛奶/纯水归"饮品"（旧快照口径），先于麦咖啡判定
  if (/盒装|纯悦/.test(n)) return { category: '饮品', mealPeriod: 'allDay' }
  // 麦咖啡：咖啡类与牛奶/燕麦调制饮品（沿用旧快照口径：牛奶/燕麦奶/雪冰/黑巧等归麦咖啡）
  if (/咖啡|美式|拿铁|玛奇朵|卡布奇诺|奶铁|阿芙佳朵|雪冰|浓缩|鲜萃|朱古力|黑巧|抹茶|牛奶|奶香|燕麦/.test(n))
    return { category: '麦咖啡', mealPeriod: 'allDay' }
  // 饮品：碳酸/茶/豆浆/果汁等
  if (/可乐|雪碧|红茶|豆浆|汁|怡泉|美汁源|橙|炫酷|水/.test(n))
    return { category: '饮品', mealPeriod: 'allDay' }
  // 小食：薯条/麦乐鸡/翅/玉米杯/鸡排/脆汁鸡/鸡球 等
  if (/薯条|麦乐鸡|翅|玉米杯|鸡球|鸡排|脆汁鸡|趣鸡/.test(n))
    return { category: '小食', mealPeriod: 'allDay' }
  // 映射不了的归小食（任务规定）
  return { category: '小食', mealPeriod: 'allDay' }
}

/** 规格单位：沿用旧快照口径（1个/1份/中/小/5块…），从名称推导，推不出为 null */
function deriveUnit(name) {
  const n = normalize(name)
  const block = n.match(/(\d+)块/)
  if (block) return `${block[1]}块`
  if (/中杯|中薯/.test(n)) return '中'
  if (/大杯|大薯/.test(n)) return '大'
  if (/小杯|小薯/.test(n)) return '小'
  if (/^迷你薯/.test(n)) return '迷你'
  if (/麦满分|堡|卷|派$|圆筒|饼|油条|香肠/.test(n)) return '1个'
  if (/粥/.test(n)) return '1份'
  return null
}

/* ============================================================
   3. 过敏原推断（非官方声明，宁缺勿滥）
   ------------------------------------------------------------
   优先复用旧官网快照中同名条目的推断结果（去空格、去规格后缀匹配）；
   未命中的按名称关键词规则推断，无法推断为 null。
   ============================================================ */

/** 关键词 → [过敏原, 依据短语]；顺序即输出顺序 */
const ALLERGEN_RULES = [
  ['牛奶', /牛奶|奶铁|玛奇朵|卡布奇诺|阿芙佳朵|雪冰|黑巧|抹茶|朱古力|冰淇淋|新地|麦旋风|奶冻|奶香|芝士|吉士/, '名称含奶制品/冰淇淋关键词→牛奶（推断）'],
  ['鸡蛋', /蛋/, "名称含'蛋'→鸡蛋（推断）"],
  ['麸质', /堡|卷|麦满分|油条|薯饼|派|圆筒|麦乐鸡|脆脆薯条|鸡排|脆汁鸡|趣鸡球|面包/, '堡卷/裹粉油炸/小麦烘焙制品→麸质（推断）'],
  ['鱼类', /鱼/, "名称含'鱼'→鱼类（推断）"],
  ['甲壳类', /虾|蟹/, "名称含'虾/蟹'→甲壳类（推断）"],
  ['花生', /花生/, "名称含'花生'→花生（推断）"],
  ['坚果及其果仁类制品', /坚果|开心果|杏仁|腰果|榛子|核桃/, "名称含坚果关键词→坚果（推断）"],
  ['大豆', /豆浆|大豆/, "名称含'豆浆'→大豆（推断）"],
  ['猪肉', /猪柳|培根|火腿|图林根|烟肉/, '猪柳/培根/火腿/图林根/烟肉为猪肉制品（推断）'],
  ['牛肉', /牛(?!奶)/, "名称含'牛'→牛肉（推断）"],
]

function inferAllergens(name) {
  const n = normalize(name)
  const list = []
  const basis = []
  for (const [allergen, re, why] of ALLERGEN_RULES) {
    // 燕麦奶为植物基饮品，不触发牛奶推断（沿用旧快照口径）
    if (allergen === '牛奶' && /燕麦/.test(n)) continue
    if (re.test(n)) {
      list.push(allergen)
      basis.push(why)
    }
  }
  return list.length > 0 ? { allergens: list, allergenBasis: basis.join('；') } : { allergens: null, allergenBasis: null }
}

/* ============================================================
   4. 交叉校验：旧官网快照 vs 新 MCP 数据
   ============================================================ */

function crossCheck(oldItems, newItems) {
  // 两级索引：精确名称（去空格）优先，规格折叠名（去杯型/块数/括号）兜底；
  // 折叠后同名多规格（如 麦乐鸡4块/5块、大小玉米杯）时取热量最接近的一条，
  // 避免旧快照"小杯"口径误配到新数据"大杯"造成假差异。
  const exact = new Map()
  const folded = new Map()
  for (const it of newItems) {
    const e = normalize(it.name)
    if (!exact.has(e)) exact.set(e, [])
    exact.get(e).push(it)
    const f = stripSpec(it.name)
    if (!folded.has(f)) folded.set(f, [])
    folded.get(f).push(it)
  }
  const pickClosest = (list, old) => {
    let best = null
    let bestGap = Infinity
    for (const it of list) {
      const gap = Math.abs((it.calories ?? -1e9) - (old.calories ?? -1e9))
      if (gap < bestGap) { bestGap = gap; best = it }
    }
    return best
  }
  const fields = ['calories', 'protein', 'carbs', 'fat', 'sodium']
  let matched = 0
  const mismatched = []
  const perField = Object.fromEntries(fields.map((f) => [f, { same: 0, total: 0 }]))
  for (const old of oldItems) {
    const nw =
      pickClosest(exact.get(normalize(old.name)) ?? [], old) ??
      pickClosest(folded.get(stripSpec(old.name)) ?? [], old)
    if (!nw) continue
    matched++
    const diffs = []
    for (const f of fields) {
      perField[f].total++
      if (old[f] === nw[f]) perField[f].same++
      else diffs.push(`${f}: ${old[f]}→${nw[f]}`)
    }
    if (diffs.length > 0) mismatched.push(`  · ${old.name}：${diffs.join('，')}`)
  }
  console.log('\n【交叉校验】旧官网快照 与 新 MCP 数据（按名称去规格匹配）')
  console.log(`  旧快照 ${oldItems.length} 条，其中 ${matched} 条能在新数据中按名称匹配`)
  for (const f of fields) {
    const { same, total } = perField[f]
    console.log(`  ${f.padEnd(9)} 一致 ${same}/${total}（${total ? Math.round((same / total) * 1000) / 10 : 0}%）`)
  }
  const fullySame = matched - mismatched.length
  console.log(`  五项全一致：${fullySame}/${matched}（${matched ? Math.round((fullySame / matched) * 1000) / 10 : 0}%）`)
  if (mismatched.length > 0) {
    console.log(`  差异明细（共 ${mismatched.length} 条）：`)
    console.log(mismatched.join('\n'))
  }
  return { matched, fullySame, mismatchCount: mismatched.length }
}

/* ============================================================
   5. 主流程
   ============================================================ */

async function main() {
  const offline = process.argv.includes('--offline')
  const mealsCacheIdx = process.argv.indexOf('--meals-cache')
  const mealsCachePath = mealsCacheIdx > -1 ? process.argv[mealsCacheIdx + 1] : null
  console.log(`▶ 数据源：麦当劳 MCP list-nutrition-foods（${offline ? '离线缓存模式' : '在线拉取'}）`)

  // 1) 读取旧快照（用于备份、过敏原复用与交叉校验）
  const oldSnapshot = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  const oldIsWebsite = /mcdonalds\.com\.cn/.test(String(oldSnapshot.meta?.source ?? ''))

  // 2) 拉取/解析 MCP 数据
  const dataStr = offline ? fetchOffline() : await fetchOnline()
  const rows = parseTable(dataStr)
  console.log(`▶ 解析到 ${rows.length} 条营养记录`)

  // 3) 旧快照过敏原/规格索引（规范化名称 → 条目；优先非空过敏原）
  const oldMap = new Map()
  for (const it of oldSnapshot.items ?? []) {
    for (const k of new Set([normalize(it.name), stripSpec(it.name)])) {
      if (!k) continue
      const prev = oldMap.get(k)
      if (!prev || (prev.allergens == null && it.allergens != null)) oldMap.set(k, it)
    }
  }

  // 4) 映射为应用 schema
  const items = rows.map((r, i) => {
    const { category, mealPeriod } = mapCategory(r.name)
    const reused = oldMap.get(normalize(r.name)) ?? oldMap.get(stripSpec(r.name))
    const allergenInfo =
      reused && (reused.allergens != null || reused.allergenBasis != null)
        ? { allergens: reused.allergens ?? null, allergenBasis: reused.allergenBasis ?? null }
        : inferAllergens(r.name)
    const unit = deriveUnit(r.name) ?? (reused?.unit ?? null)
    return {
      id: `mcp-${String(i + 1).padStart(3, '0')}`,
      name: r.name,
      category,
      mealPeriod,
      calories: r.energyKcal,
      protein: r.protein,
      carbs: r.carbohydrate,
      fat: r.fat,
      sodium: r.sodium,
      allergens: allergenInfo.allergens,
      allergenBasis: allergenInfo.allergenBasis,
      price: null, // 先置 null，价格步骤（query-meals 匹配）命中后覆盖为 currentPrice
      unit,
      sourceUrl: 'https://mcp.mcd.cn (MCP: list-nutrition-foods)',
    }
  })

  // 4b) 价格步骤：query-meals 门店在售菜单 → 名称匹配填价
  //     --meals-cache 指定时走离线回退；否则在线拉取，失败时降级为全部 null（不中断快照生成）
  let priceInfo = { count: 0, rate: 0 }
  let priceStoreCode = '1450034'
  try {
    const mealsResult = mealsCachePath ? fetchMealsFromCache(mealsCachePath) : await fetchMealsOnline()
    priceStoreCode = mealsResult.storeCode
    priceInfo = applyPrices(items, mealsResult.meals)
  } catch (e) {
    if (mealsCachePath) throw e // 显式指定缓存却失败：视为错误，避免静默产出无价格快照
    console.warn(`⚠️ 价格步骤在线拉取失败（${e.message}），本快照价格全部保持 null`)
  }

  // 5) 统计输出
  const catDist = {}
  for (const it of items) catDist[it.category] = (catDist[it.category] ?? 0) + 1
  const allergenCover = items.filter((it) => it.allergens != null).length
  console.log('\n【分类分布】', JSON.stringify(catDist))
  console.log(`【过敏原覆盖】${allergenCover}/${items.length} 条有推断过敏原（${Math.round((allergenCover / items.length) * 1000) / 10}%）`)

  // 6) 生成器硬性要求自检（候选数必须 > 0）
  const breakfastStaples = items.filter(
    (it) => it.mealPeriod === 'breakfast' && it.category === '早餐' && /堡|卷|麦满分/.test(it.name)
  )
  const burgerStaples = items.filter((it) => it.mealPeriod === 'allDay' && it.category === '汉堡和卷')
  const sidePool = items.filter(
    (it) => it.mealPeriod === 'allDay' && ['小食', '饮品', '麦咖啡', '甜品'].includes(it.category)
  )
  console.log(
    `\n【生成器候选自检】早餐主食 ${breakfastStaples.length}，午晚主食 ${burgerStaples.length}，配菜池 ${sidePool.length}`
  )
  if (breakfastStaples.length === 0 || burgerStaples.length === 0 || sidePool.length === 0) {
    throw new Error('分类映射不满足生成器要求（候选数为 0），请调整映射规则后重跑')
  }

  // 7) 交叉校验（旧快照仍是官网来源时才比对；重跑时旧文件已是 MCP 数据则跳过）
  if (oldIsWebsite) crossCheck(oldSnapshot.items ?? [], items)

  // 8) 备份旧官网快照（仅一次）
  if (oldIsWebsite && !fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(DATA_FILE, BACKUP_FILE)
    console.log(`\n▶ 已备份旧官网快照 → ${path.relative(ROOT, BACKUP_FILE)}`)
  }

  // 9) 写入新快照
  const snapshot = {
    meta: {
      source: "McDonald's MCP Server (mcd-mcp) - list-nutrition-foods",
      fetchedAt: todayLocal(),
      note: `营养数据来自麦当劳 MCP 官方接口 list-nutrition-foods（${todayLocal()} 拉取，160 个单品，能量/蛋白质/脂肪/碳水/钠为官方实测值）；价格来自麦当劳 MCP query-meals 上海徐家汇餐厅（storeCode ${priceStoreCode}）${todayLocal()} 在售菜单 currentPrice，按名称规范化匹配填充 ${priceInfo.count}/160 条，未匹配单品为 null（界面显示"未公开"）；过敏原仍为餐品名称关键词推断（非官方声明）。旧官网快照备份于 mcdonalds-menu.website-backup.json。`,
      fields: oldSnapshot.meta.fields,
    },
    items,
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  console.log(`▶ 已写入 ${path.relative(ROOT, DATA_FILE)}（${items.length} 条）`)

  // 10) 端到端冒烟：用真实生成器为样例用户出 3 套方案并断言 ±5%
  const { generatePlans } = await import(pathToFileURL(path.join(ROOT, 'src', 'utils', 'planGenerator.js')).href)
  const { plans, error } = generatePlans({ items, targetCalories: 1400, allergens: ['牛奶'] })
  if (error || plans.length !== 3) throw new Error(`冒烟测试失败：${error ?? '方案数不为 3'}`)
  for (const p of plans) {
    const dev = (p.totals.calories - 1400) / 1400
    if (Math.abs(dev) > 0.05) throw new Error(`冒烟测试失败：${p.strategy} 偏差 ${(dev * 100).toFixed(1)}% 超出 ±5%`)
    console.log(`  ✓ ${p.strategy}：${p.totals.calories} kcal（偏差 ${(dev * 100).toFixed(1)}%），蛋白 ${p.totals.protein} g`)
  }
  console.log('▶ 冒烟测试通过：三套方案均在目标 ±5% 内')
}

main().catch((e) => {
  console.error(`✖ 失败：${e.message}`)
  process.exitCode = 1
})
