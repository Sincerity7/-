# workbuddy.md — WorkBuddy 开发对话上下文导出

> 本文档为【麦门减脂营养师】使用 WorkBuddy 辅助开发的完整对话上下文导出，用于麦当劳程序员节创意开发大赛 WorkBuddy 专项奖励评审。开发全程采用 Spec 驱动模式（规格 → 任务清单 → 检查清单 → 子代理并行实现 → 端到端验证）。

## 一、需求输入（用户原始 Prompt）

用户以 `/spec` 指令输入完整需求：

- 角色定位：【麦门减脂营养师】参赛作品，依赖麦当劳 MCP 工具获取官方餐品数据（名称、热量、蛋白质、碳水、脂肪、钠、过敏原、售价）。
- 工作流程：①先收集用户信息（性别/身高/体重/活动量/每日热量上限/过敏原忌口），信息不全引导补齐，不瞎搭配；②获取全部商品数据并自动过滤含过敏原餐品；③生成 3 套独立早+午+晚套餐，总热量严格控制、优先高蛋白低钠；④每套输出餐品清单/单品价格/总价/总热量/三大营养素汇总；⑤3 套横向对比并标注场景（控卡优先/性价比优先/饱腹感优先）；⑥支持指定单品查营养、"不喜欢"自动替换同热量同类型单品。
- 硬性约束：markdown 表格+分割线输出、方便前端渲染、不编造不存在的麦当劳产品、所有数据来自官方来源。
- 指定能力：web-app-development 插件、ckm:ui-styling 界面美化技能、TRAE-debugger 调试技能（备用）。

## 二、Spec 规划阶段

WorkBuddy 生成三份规格文档（`.trae/specs/build-mcdonalds-fatloss-nutritionist/`）：

- `spec.md`：Why/What Changes/Impact + 8 项 ADDED Requirements（数据快照、信息收集、过滤、套餐生成、Markdown 输出、对比、额外指令、品牌 UI），每项含 WHEN/THEN 验收场景。
- `tasks.md`：Task 0–9 共 10 个任务、20+ 子任务，含依赖关系（逻辑层 → UI → 端到端验证）。
- `checklist.md`：26 项可勾选核验点，覆盖数据真实性、算法约束、UI 交互、工程构建。

## 三、关键决策与用户确认（AskUserQuestion）

1. **数据来源决策**：开发环境未配置麦当劳 MCP Server（mcd-mcp），用户选择"官网数据快照+可替换数据层"——由 WorkBuddy 抓取麦当劳中国官网真实数据内置为快照，数据层接口签名对齐 MCP 返回格式，未来可无缝替换。
2. **技术栈决策**：用户选择 Vue 3 + Vite + Element Plus（纯前端 SPA，markdown 由前端渲染）。
3. **数据降级决策**（开发中发现官网公开网页不披露过敏原与单品价格后，WorkBuddy 主动核实并向用户确认）：
   - 过敏原 → 采用"餐品名称关键词 + 官网新闻页官方过敏原提示"推断，每条附推断依据并标注"非官方声明"；
   - 价格 → 界面显示"未公开"，"性价比优先"策略改用代理指标（每 100kcal 蛋白质克数最高）。
   - 全程坚持"不编造数据"原则，以上口径同步写入界面页脚与 MCP_INTEGRATION.md。

## 四、实现阶段（子代理并行执行）

| 阶段 | 子代理任务 | 结果 |
| --- | --- | --- |
| 数据抓取 | 官网产品页/营养计算器逐页抓取 | 91 个单品，营养字段覆盖 98.9%，能量按 kJ/4.184 换算 kcal |
| 脚手架 | Vite6 + Vue3.5 + Element Plus2.9 + marked15 | build 通过，全中文注释 |
| 过敏原补全 | 名称关键词+官方资讯保守推断 | 覆盖率 63/91（69.2%），null 保留 28 条，零编造 |
| 核心逻辑层 | mcpClient / nutrition（Mifflin-St Jeor BMR+TDEE）/ planGenerator（±5% 热量约束+三策略打分）/ substitute / markdownOutput | Node 30+ 断言全过，生成耗时 23–36ms |
| 前端 UI | 表单/方案卡片/对比面板/单品查询/替换还原交互 + 麦当劳品牌风格（红#DA291C/金#FFC72C，WCAG AA，<768px 单列） | build+dev 冒烟通过 |

## 五、验证阶段

- **静态+脚本核验**：13/13 项 PASS（数据真实性 WebFetch 抽查吻合、牛奶过敏过滤命中数=0、9 组 target×档案总热量全部 ±5% 内、三策略区分度断言、极端忌口 error 兜底、替换热量差 5.4% 且还原逐字段复原、markdown 渲染合法）。
- **浏览器端到端**：填表（女/165/60/久坐/1400kcal/牛奶过敏）→ 生成 3 套 1330/1403/1469 kcal 达标 → 对比表渲染 → 搜索"麦香鱼"返回完整营养行且价格"未公开"→ 替换按钮正确触发业务规则。
- **checklist.md 26 项全部勾选**，`npm run build` 最终通过。

## 六、参赛材料产出

- `README.md`：项目介绍/安装方法/使用示例/目标用户（活动必交项）。
- `CONTEST_DECLARATION.md`：官方参赛声明原文逐字复制（文件名与内容未改动）。
- `MCP_INTEGRATION.md`：MCP Server 接入配置（仅占位符 Token）、5 个 Tool 清单（`list-nutrition-foods`/`query-meals`/`query-meal-detail`/`calculate-price`/`now-time-info`）、调用流程与业务价值。
- 报名 Issue 文案：按活动严格格式（字段间不换行、地址不用 Markdown 链接）生成。

## 七、过程文件索引

- 规格三件套：`.trae/specs/build-mcdonalds-fatloss-nutritionist/{spec.md, tasks.md, checklist.md}`
- 数据快照：`src/data/mcdonalds-menu.json`（meta 含 source/fetchedAt/口径说明）
- 源码：`src/{services,utils,components}/`（全部中文注释）
