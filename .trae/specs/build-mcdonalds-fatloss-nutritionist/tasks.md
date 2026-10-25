# Tasks

- [x] Task 0: 抓取麦当劳中国官网餐品数据并生成标准快照（已完成：91 个单品，营养字段覆盖 98.9%，抽查 5 项与官网一致；过敏原/价格官网公开页不披露，转入 SubTask 0.3 降级方案）
  - [x] SubTask 0.1: 通过官网（mcdonalds.com.cn）产品列表/营养页面，抓取真实餐品的名称、分类、可售餐段、热量、蛋白质、碳水、脂肪、钠、过敏原、售价（目标：覆盖汉堡/小食/甜品/饮品/早餐等主流品类，≥60 个单品；官网未公开的字段记 null，严禁编造）
  - [x] SubTask 0.2: 整理为 MCP 返回格式 JSON：`src/data/mcdonalds-menu.json` + 元信息（source、fetchedAt、字段说明）
  - [x] SubTask 0.3: 过敏原推断补全（用户已确认降级方案）：按"餐品名称关键词 + 官网新闻页官方过敏原提示"为每个单品填充 `allergens`（中文数组）与 `allergenBasis`（推断依据说明），无法推断的保持 null；meta.note 注明"过敏原为推断数据，非官方声明；price 官网未公开保持 null"（已完成：覆盖率 63/91=69.2%，保守推断，null 保留 28 条）
  - 验证：抽查 5 个单品数值与官网页面一致；JSON 可被解析、字段齐全

- [x] Task 1: 项目脚手架搭建（已完成：Vite6+Vue3.5+Element Plus2.9+marked15，npm install 成功，build 通过，dev 5173 可启动）
  - [x] SubTask 1.1: 在工作区根目录初始化 Vite + Vue 3 项目，安装 Element Plus、marked
  - [x] SubTask 1.2: 建立目录结构（data/services/utils/components）与基础页面骨架；全部代码中文注释
  - 验证：`npm run dev` 可启动、`npm run build` 通过

- [x] Task 2: 数据服务层 mcpClient（已完成：getMenu/searchItems/filterSafe/byMealPeriod，null 过敏原透传 allergenUnknown）
  - [x] SubTask 2.1: 实现 `getMenu()`（读取内置快照，接口签名对齐未来真实 MCP 返回）、按分类/餐段查询、按名称搜索
  - [x] SubTask 2.2: 实现过敏原/忌口关键词过滤函数（allergens=null 时标记"过敏原未知"透传；忌口自定义关键词匹配餐品名称）
  - 验证：过滤逻辑在样例数据上结果正确

- [x] Task 3: 营养计算工具 nutrition.js（已完成：calcBMR/calcTDEE/ACTIVITY_LEVELS，样例核对通过）
  - [x] SubTask 3.1: Mifflin-St Jeor BMR + 活动系数 TDEE 计算，供表单参考值使用
  - 验证：用已知样例（男/175cm/70kg/中度活动）核对数值

- [x] Task 4: 套餐生成器 planGenerator.js（已完成：1400kcal 样例 3 套 1330/1403/1469 均达标，性能 23–36ms，无解返回标准 error）
  - [x] SubTask 4.1: 三餐热量配额（早30%/午40%/晚30%）+ 组合搜索，使整套总热量落在目标 ±5%
  - [x] SubTask 4.2: 三种策略打分函数：控卡优先（总热量最接近目标下限+钠最低）、性价比优先（代理指标：每 100kcal 蛋白质克数最高，价格官网未公开）、饱腹感优先（蛋白+脂肪+总克重代理最高）；同达标优先高蛋白低钠
  - [x] SubTask 4.3: 无解兜底：返回明确失败原因而非强行输出
  - 验证：给定 1600kcal 样例用户，3 套方案均达标且各策略特征明显

- [x] Task 5: 单品替换与查询逻辑（已完成：findSubstitute/applySubstitute/restoreOriginal/sumPlan，替换热量差 9.7%、整套 ±5% 保持、还原逐字段一致）
  - [x] SubTask 5.1: 替换候选筛选：同分类/同餐段、热量 ±10%、不含用户过敏原/忌口
  - [x] SubTask 5.2: 替换后整套汇总与对比数据实时重算；支持还原
  - 验证：替换后热量差 ≤10% 且整套仍在 ±5% 内

- [x] Task 6: Markdown 输出模块 markdownOutput.js（已完成：renderPlanMarkdown/renderComparisonMarkdown，marked 解析通过，"未公开"/供能比/过敏原提示齐全）
  - [x] SubTask 6.1: 生成每套方案的清单表格、分割线、总价/总热量/三大营养素汇总（价格 null 显示"未公开"，过敏原推断数据显示"推断，非官方声明"标注）
  - [x] SubTask 6.2: 生成三套横向对比表格（含场景标注，价格列显示"未公开"）
  - 验证：输出为合法 markdown，marked 渲染无错

- [x] Task 7: 前端 UI 组装（已完成：UserProfileForm/PlanCard/ComparisonPanel/ItemQueryPanel/App 组装，build+dev 冒烟通过）
  - [x] SubTask 7.1: 用户信息表单（必填校验、逐项引导、BMR/TDEE 参考值展示、过敏原多选+自定义忌口；过敏原枚举须与数据用词一致：麸质/牛奶/鸡蛋/鱼类/甲壳类/花生/坚果及其果仁类制品/大豆/猪肉/牛肉）
  - [x] SubTask 7.2: 套餐结果页：3 张方案卡片（marked 渲染 markdown）+ 对比板块 + 过敏原推断/未知提示 + 无解 error 提示
  - [x] SubTask 7.3: 单品查询面板 + 每行"不喜欢→替换/还原"交互
  - 验证：浏览器端到端走通完整流程

- [x] Task 8: UI 美化与响应式（已完成：品牌色板 CSS 变量+金拱门 hero 元素+卡片色调区分+markdown 表格美化+<768px 单列）
  - [x] SubTask 8.1: 麦当劳品牌风格视觉（红黄主色、卡片化、移动端适配、无障碍对比度）
  - 验证：桌面与窄屏渲染正常

- [x] Task 9: 端到端验证与缺陷闭环（已完成：静态+脚本核验 13/13 PASS；浏览器 E2E 填表→生成→对比→查询→替换交互全链路验证通过，无缺陷需修复）
  - [x] SubTask 9.1: 浏览器代理按 checklist 全流程验证；发现问题→修复→复验（实测：1400kcal+牛奶过敏 → 3 卡片 1330/1403/1469 达标、对比表齐全、搜索麦香鱼正常、替换按钮正确触发业务规则）
  - [x] SubTask 9.2: `npm run build` 最终通过（vite 6.4.5 ✓ 1615 modules，6.05s）

# Task Dependencies
- Task 2、3 依赖 Task 0、1（Task 0 数据已就绪，可开始）
- Task 4、5 依赖 Task 2、3
- Task 6 依赖 Task 4
- Task 7 依赖 Task 2–6（已全部完成）
- Task 8 依赖 Task 7
- Task 9 依赖 Task 8
- SubTask 0.3 与 Task 2–6 可并行（0.3 只改数据文件，逻辑层按 schema 编码）
