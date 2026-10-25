# MCP_INTEGRATION — 麦当劳 MCP 集成说明

本项目为"麦当劳程序员节创意开发大赛"参赛作品【麦门减脂营养师】，以下为实际使用的麦当劳 MCP Server、Tool、调用流程与业务价值说明。

## 1. 使用的 MCP Server

| 项 | 值 |
| --- | --- |
| 服务名称 | 麦当劳 MCP Server（mcd-mcp，麦当劳中国官方提供） |
| 接入地址 | `https://mcp.mcd.cn` |
| 协议类型 | Streamable HTTP（JSON-RPC 2.0） |
| 鉴权方式 | 请求头 `Authorization: Bearer <MCP_TOKEN>`，Token 在开放平台 https://open.mcd.cn/mcp 申请 |
| 限流 | 每 Token 每分钟最多 600 次请求（超限返回 429） |
| 连通状态 | **Token 已申请并验证连通**：`tools/list` 实测返回 35 个工具；`list-nutrition-foods` 实测返回 160 个单品的官方营养数据；`query-nearby-stores` + `query-meals` 实测打通价格链路（上海徐家汇餐厅 storeCode 1450034，在售菜单 88 条，2026-10-26 拉取） |

接入配置示例（本仓库不包含任何真实 Token，仅使用占位符；真实 Token 存放于被 `.gitignore` 忽略的 `.env`，脚本运行时读取，绝不输出）：

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_TOKEN"
      }
    }
  }
}
```

## 2. 使用的 Tool 清单

### 2.1 本项目已接入

| Tool | 名称 | 在本项目中的用途 |
| --- | --- | --- |
| `list-nutrition-foods` | 餐品营养信息列表 | **核心数据源（已线上调用）**：获取 160 个单品的能量（kJ/kcal）、蛋白质、脂肪、碳水化合物、钠、钙官方实测值，作为热量计算与套餐生成的基础 |
| `query-nearby-stores` | 查询可点餐门店 | **价格链路前置（已线上调用）**：按城市"上海"+关键词"徐家汇"查询门店列表，选取 24 小时营业（00:00-23:59）的 storeCode 1450034（失败自动换 1450002 静安寺） |
| `query-meals` | 查询当前可售卖的餐品列表 | **价格数据源（已线上调用）**：获取门店在售菜单 88 条（code→名称/currentPrice/originalPrice），构建期按名称规范化匹配为营养单品填价（59/160 命中，宁缺勿滥） |

### 2.2 与本项目相关、当前版本未接入的工具

后续版本可按下列路径继续补齐：

| Tool | 名称 | 规划用途 |
| --- | --- | --- |
| `query-meal-detail` | 查询餐品详情 | 提供套餐组成与可替换选项，支撑"不喜欢→自动替换"功能 |
| `calculate-price` | 商品价格计算 | 计算套餐/优惠券组合后的实付价，进一步精化"性价比优先"策略（当前总价为单品 currentPrice 直接合计） |
| `now-time-info` | 获取当前时间信息 | 判断当前餐段（早餐/全天），辅助早午晚三餐搭配 |
| `query-store-coupons` / `available-coupons` / `query-my-coupons` | 优惠券查询与领取 | 结合门店与用户券资产，输出更贴近实付价的性价比方案 |

## 3. 调用流程与架构

```
构建期（一次性，node scripts/fetch-mcp-data.mjs）
  .env 读取 MCD_MCP_URL / MCD_MCP_TOKEN（仅运行时使用，绝不写入产物）
        │
        ├─▶ query-nearby-stores（上海/徐家汇）→ 选 24 小时门店 1450034
        │        └─▶ query-meals → 在售菜单 88 条 code→currentPrice
        │             （门店打烊报 600057 时自动换店；--meals-cache 可离线回退）
        ▼
  POST https://mcp.mcd.cn  JSON-RPC 2.0 tools/call → list-nutrition-foods
        │  解析 result 中 160 条紧凑表格数据
        ▼
  分类/餐段映射 + 过敏原名称推断 + 名称规范化匹配填价（59/160）+ 与旧官网快照交叉校验
        │
        ▼
  src/data/mcdonalds-menu.json（应用内快照，旧快照备份为 *.website-backup.json）

运行期（浏览器端，零 Token、无 CORS 问题）
  用户填写身体数据与忌口
        │
        ▼
  mcpClient.getMenu()  ←—— 统一数据入口（src/services/mcpClient.js）
        │
        ▼
  过敏原/忌口过滤 filterSafe → planGenerator 生成 3 套 ±5% 控卡方案
        → markdownOutput 表格输出 → 对比板块 / 单品查询 / 替换还原
```

**为什么采用构建期脚本拉取而非浏览器端直连**：MCP Token 属敏感凭证，浏览器端直连既会暴露 Token，也会遭遇跨域（CORS）限制；构建期脚本拉取生成快照后，前端数据层零改动即可消费官方真实数据，同时保留 `getMenu()` 单一入口，未来可平滑升级为带缓存的运行时代理调用。

## 4. 数据口径说明（诚实声明）

- **营养数据**：来自麦当劳 MCP 官方接口 `list-nutrition-foods`（2026-10-26 拉取，160 个单品），能量/蛋白质/脂肪/碳水/钠为官方实测值；与旧官网快照交叉校验，可按名称匹配的 86 条中 97.7% 五项数值完全一致（差异为旧数据换算舍入 1 kcal 与旧快照缺失值补齐）。
- **过敏原**：MCP 营养接口不返回过敏原字段，仍采用"餐品名称关键词 + 常识性配方"推断（60.6% 条目有推断结果，其余标注"未知"），界面明确标注"推断数据，非官方声明"。
- **价格**：已接入 `query-nearby-stores` + `query-meals`，取上海徐家汇餐厅（storeCode 1450034，24 小时营业）2026-10-26 在售菜单 `currentPrice`，按名称规范化匹配填充 59/160 条（宁缺勿滥：去空格/【】/括号备注/杯型/块数后，全等或"双向包含且长度差 ≤1"且候选唯一才命中），未匹配单品为 null，界面显示"未公开"。注意：`query-meals` 受门店营业时间约束（普通门店打烊后返回 600057"不在营业时间"，故选 24 小时门店，脚本支持 `--meals-cache` 离线回退）；**价格随门店与时间浮动**，且为单品现价直接合计（未含套餐/优惠券组合价，`calculate-price` 未接入），下单前以官方渠道实时结果为准。

以上口径在应用界面（页脚"数据口径声明"）同步展示，不构成任何编造数据。

## 5. 业务价值

- 将麦当劳 MCP 的**官方餐品营养能力与门店在售价格能力**转化为面向减脂人群的实用配餐助手：严格热量控制（目标 ±5%）、高蛋白低钠偏好、过敏原安全过滤、真实门店价格辅助性价比决策；
- 3 套方案横向对比（控卡/性价比/饱腹三策略）+ 单品营养查询 + 一键替换，覆盖"决策—对比—微调"完整点餐链路；
- "构建期 MCP 拉取（营养 + 门店价格双链路）+ 运行期零 Token 快照消费"的工程实现，展示了从"官方数据能力"到"场景化 Skill"的可复制集成范式，并预留了套餐详情/优惠券等工具的升级路径。
