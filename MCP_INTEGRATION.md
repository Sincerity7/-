# MCP_INTEGRATION — 麦当劳 MCP 集成说明

本项目为"麦当劳程序员节创意开发大赛"参赛作品【麦门减脂营养师】，以下为实际使用的麦当劳 MCP Server、Tool、调用流程与业务价值说明。

## 1. 使用的 MCP Server

| 项 | 值 |
| --- | --- |
| 服务名称 | 麦当劳 MCP Server（mcd-mcp，麦当劳中国官方提供） |
| 接入地址 | `https://mcp.mcd.cn` |
| 协议类型 | Streamable HTTP |
| 鉴权方式 | 请求头 `Authorization: Bearer <MCP_TOKEN>`，Token 在开放平台 https://open.mcd.cn/mcp 申请 |
| 限流 | 每 Token 每分钟最多 600 次请求（超限返回 429） |

接入配置示例（本仓库不包含任何真实 Token，仅使用占位符）：

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

| Tool | 名称 | 在本项目中的用途 |
| --- | --- | --- |
| `list-nutrition-foods` | 餐品营养信息列表 | **核心数据源**：获取餐品的能量、蛋白质、脂肪、碳水化合物、钠等营养数据，作为热量计算与套餐生成的基础 |
| `query-meals` | 查询当前可售卖的餐品列表 | 获取门店在售菜单（分类、餐品编码、标签），保证推荐方案只包含实际在售餐品 |
| `query-meal-detail` | 查询餐品详情 | 提供套餐组成与可替换选项，支撑"不喜欢→自动替换同类型、热量±10%单品"功能 |
| `calculate-price` | 商品价格计算 | 计算整套方案总价与单品价格（官网公开网页不披露单品价格，接入 MCP 后由此工具补齐） |
| `now-time-info` | 获取当前时间信息 | 判断当前餐段（早餐/全天），辅助早午晚三餐搭配 |

## 3. 调用流程与架构

```
用户填写身体数据与忌口
        │
        ▼
mcpClient.getMenu()  ←—— 统一数据入口（src/services/mcpClient.js）
        │
        ├─【在线模式·目标形态】调用麦当劳 MCP：
        │    list-nutrition-foods（营养）
        │    + query-meals（在售菜单）
        │    + query-meal-detail（替换候选）
        │    + calculate-price（价格）
        │
        └─【当前演示模式】读取内置官方数据快照
             src/data/mcdonalds-menu.json
             （结构严格对齐 list-nutrition-foods 返回格式）
        │
        ▼
过敏原/忌口过滤 filterSafe → planGenerator 生成 3 套 ±5% 控卡方案
        → markdownOutput 表格输出 → 对比板块 / 单品查询 / 替换还原
```

**接入真实 MCP 的切换方式**：仅需将 `src/services/mcpClient.js` 中 `getMenu()` 的内部实现由"读取内置快照"替换为对 `https://mcp.mcd.cn` 的 Streamable HTTP 调用（携带 Bearer Token），返回结构无需变化，上层过滤、生成、渲染逻辑**零改动**。

## 4. 数据口径说明（诚实声明）

开发环境未持有 MCP Token，当前版本运行于内置数据快照模式：

- **营养数据**：抓取自麦当劳中国官网公开产品页（能量按 kJ/4.184 换算为 kcal，与官网营养计算器口径一致），真实可溯源，抽查核验通过；
- **过敏原**：官网公开网页不披露，采用"餐品名称关键词 + 官网新闻页官方过敏原提示"推断，界面明确标注"推断数据，非官方声明"；
- **价格**：官网公开网页不披露单品价格，界面显示"未公开"；接入 MCP 后由 `calculate-price` 补齐真实价格，"性价比优先"策略即可切换为真实价格排序。

以上口径在应用界面（页脚"数据口径声明"）同步展示，不构成任何编造数据。

## 5. 业务价值

- 将麦当劳 MCP 的官方餐品营养/菜单/价格能力转化为一个**面向减脂人群的实用配餐助手**：严格热量控制（目标 ±5%）、高蛋白低钠偏好、过敏原安全过滤；
- 3 套方案横向对比（控卡/性价比/饱腹三策略）+ 单品营养查询 + 一键替换，覆盖"决策—对比—微调"完整点餐链路；
- 数据层与 MCP 返回结构对齐的工程实现，展示了从"官方数据能力"到"场景化 Skill"的可复制集成范式。
