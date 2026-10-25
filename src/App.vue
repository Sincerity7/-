<script setup>
/**
 * 根组件：麦门减脂营养师（Task 8 组装）
 * 流程：品牌 hero → 画像表单 → 生成按钮 → 三套方案卡片 + 对比面板 → 单品查询 → 页脚声明。
 * 逻辑层（mcpClient / nutrition / planGenerator / substitute / markdownOutput）零改动，仅做编排。
 */
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getMenu } from './services/mcpClient.js'
import { generatePlans } from './utils/planGenerator.js'
import UserProfileForm from './components/UserProfileForm.vue'
import PlanCard from './components/PlanCard.vue'
import ComparisonPanel from './components/ComparisonPanel.vue'
import ItemQueryPanel from './components/ItemQueryPanel.vue'

/* ---------- 菜单数据加载 ---------- */
const menuItems = ref([]) // 全量单品（PlanCard 替换候选池 / generatePlans 输入）
const menuMeta = ref(null) // 快照元信息（来源、抓取日期）
const loadingMenu = ref(true)

onMounted(async () => {
  try {
    const { meta, items } = await getMenu()
    menuItems.value = items
    menuMeta.value = meta
  } catch (e) {
    ElMessage.error(`菜单数据加载失败：${e?.message ?? '未知错误'}`)
  } finally {
    loadingMenu.value = false
  }
})

/* ---------- 方案生成 ---------- */
const generating = ref(false) // 生成按钮 loading 态
const plans = ref([]) // 成功结果：三套方案
const genError = ref('') // 失败结果：generatePlans 返回的 error 文案
const activeProfile = ref(null) // 当前生成所用画像，PlanCard 替换时复用其忌口与热量上限

/**
 * 表单 submit 回调：调用 generatePlans。
 * 返回 error 时用醒目 el-alert 展示错误与建议，不渲染方案卡片。
 */
function handleGenerate(profile) {
  if (loadingMenu.value) {
    ElMessage.warning('菜单数据尚未加载完成，请稍候再试')
    return
  }
  generating.value = true
  genError.value = ''
  plans.value = []
  // 同步计算前先让 loading 态渲染一帧，避免按钮无反馈
  requestAnimationFrame(() => {
    try {
      const result = generatePlans({
        items: menuItems.value,
        targetCalories: profile.targetCalories,
        allergens: profile.allergens,
        customKeywords: profile.customKeywords,
      })
      if (result.error) {
        genError.value = result.error
      } else {
        activeProfile.value = profile
        plans.value = result.plans
      }
    } catch (e) {
      genError.value = `生成方案时出错：${e?.message ?? '未知错误'}`
    } finally {
      generating.value = false
    }
  })
}

/** PlanCard 替换/还原后同步回 plans，保证对比面板与卡片一致 */
function handlePlanChange(index, nextPlan) {
  plans.value = plans.value.map((p, i) => (i === index ? nextPlan : p))
}
</script>

<template>
  <div class="layout">
    <!-- 品牌 hero：墨色底 + 金色"金拱门"装饰弧线 + 数据来源徽章 -->
    <header class="hero">
      <div class="hero-inner">
        <h1 class="hero-title">麦门<span class="hero-title-accent">减脂营养师</span></h1>
        <p class="hero-tagline">
          用麦当劳 MCP 官方营养数据，为你配出达标、可控、吃得下去的减脂三餐
        </p>
        <div class="hero-badges">
          <span class="source-badge">麦当劳 MCP 官方接口 list-nutrition-foods</span>
          <span v-if="menuMeta?.fetchedAt" class="source-badge source-badge--sub">
            数据拉取于 {{ menuMeta.fetchedAt }} · {{ menuItems.length }} 个单品
          </span>
        </div>
      </div>
    </header>

    <main class="app-main">
      <!-- 第一步：画像与忌口表单（内含生成按钮） -->
      <UserProfileForm :loading="generating" @submit="handleGenerate" />

      <!-- 生成失败：醒目错误提示 + 建议，不渲染方案卡片 -->
      <el-alert
        v-if="genError"
        class="error-alert"
        type="error"
        :closable="false"
        show-icon
        :title="genError"
        description="建议：减少勾选的过敏原、精简自定义忌口词，或适当提高每日热量上限后重新生成。"
      />

      <!-- 生成成功：三套方案卡片 + 横向对比 -->
      <template v-if="plans.length">
        <h2 class="section-title">为你生成的三套减脂方案</h2>
        <div class="plans-grid">
          <PlanCard
            v-for="(plan, i) in plans"
            :key="plan.strategy"
            :plan="plan"
            :items="menuItems"
            :allergens="activeProfile?.allergens ?? []"
            :custom-keywords="activeProfile?.customKeywords ?? []"
            :target-calories="activeProfile?.targetCalories ?? plan.targetCalories"
            @change="handlePlanChange(i, $event)"
          />
        </div>
        <ComparisonPanel class="comparison-wrap" :plans="plans" />
      </template>

      <!-- 单品查询面板：独立于生成流程，随时可查 -->
      <ItemQueryPanel class="query-wrap" />
    </main>

    <!-- 页脚：数据口径声明 -->
    <footer class="app-footer">
      <h3 class="footer-title">数据口径声明</h3>
      <ul class="footer-list">
        <li>营养数据来自麦当劳 MCP 官方接口 list-nutrition-foods（160 个单品的能量/蛋白质/脂肪/碳水/钠实测值，构建期由 scripts/fetch-mcp-data.mjs 在线拉取生成）。</li>
        <li>过敏原为基于餐品名称与常识性配方的<b>推断数据，非官方声明</b>；未知项请自行确认。</li>
        <li>价格来自 MCP 门店菜单（上海徐家汇餐厅，2026-10-26 在售 currentPrice），未收录单品显示"未公开"。</li>
        <li>数据快照在构建期生成，浏览器端零 Token 暴露；价格链路已接入 <code>query-nearby-stores</code> + <code>query-meals</code>，价格随门店与时间浮动，下单前以官方渠道实时结果为准。</li>
      </ul>
      <p class="footer-copy">麦门减脂营养师 · 仅供营养参考，不构成医疗建议</p>
    </footer>
  </div>
</template>

<style>
/* ============================================================
   全局品牌样式：CSS 变量定义麦当劳品牌色 + Element Plus 主色覆盖
   ============================================================ */
:root {
  /* 品牌色板 */
  --mc-red: #da291c;        /* 麦当劳经典红 */
  --mc-gold: #ffc72c;       /* 金黄（金拱门） */
  --mc-ink: #27251f;        /* 墨色（正文/深色底） */
  --mc-cream: #fbf7ef;      /* 奶油底色（页面背景） */
  --mc-paper: #ffffff;      /* 卡片纸白 */
  --mc-line: #eae3d6;       /* 分隔线暖灰 */
  --mc-muted: #6b675e;      /* 次要文字 */

  /* Element Plus 主色替换为品牌红（含各明度档） */
  --el-color-primary: var(--mc-red);
  --el-color-primary-light-3: #e56960;
  --el-color-primary-light-5: #ed948d;
  --el-color-primary-light-7: #f4bfbb;
  --el-color-primary-light-8: #f8d4d2;
  --el-color-primary-light-9: #fbe9e8;
  --el-color-primary-dark-2: #ae2116;
  --el-border-radius-base: 10px;
  --el-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}

body {
  margin: 0;
  background: var(--mc-cream);
  color: var(--mc-ink);
  font-family: var(--el-font-family);
  -webkit-font-smoothing: antialiased;
}

/* 表格横向滚动容器：窄屏下 markdown 表格不溢出页面 */
.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

/* ---------- marked 渲染的 Markdown 美化 ---------- */
.markdown-body {
  font-size: 14px;
  line-height: 1.7;
  color: var(--mc-ink);
}

.markdown-body h1 {
  margin: 0 0 14px;
  padding-bottom: 10px;
  font-size: 17px;
  font-weight: 700;
  border-bottom: 2px solid var(--mc-gold);
}

.markdown-body p {
  margin: 10px 0;
}

.markdown-body strong {
  color: var(--mc-red);
}

.markdown-body hr {
  margin: 16px 0;
  border: none;
  border-top: 2px dashed var(--mc-line);
}

/* 引用块（过敏原提示等）：金色左边框奶油底 */
.markdown-body blockquote {
  margin: 12px 0;
  padding: 8px 14px;
  background: #fff8e1;
  border-left: 4px solid var(--mc-gold);
  border-radius: 0 8px 8px 0;
  color: #5c5646;
}

.markdown-body blockquote p {
  margin: 4px 0;
}

/* 表格：斑马纹 + 墨色表头 + 数值列右对齐 + 分割线 */
.markdown-body table {
  width: 100%;
  min-width: 560px; /* 配合 .table-scroll 防挤压 */
  margin: 8px 0 16px;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}

.markdown-body th {
  padding: 8px 12px;
  background: var(--mc-ink);
  color: #fff;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}

.markdown-body td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--mc-line);
  text-align: left;
}

/* 第 3 列起为数值列：右对齐便于纵向比较 */
.markdown-body th:nth-child(n + 3),
.markdown-body td:nth-child(n + 3) {
  text-align: right;
}

.markdown-body tbody tr:nth-child(even) {
  background: var(--mc-cream);
}

.markdown-body tbody tr:hover {
  background: #fff3c9;
}
</style>

<style scoped>
.layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* ---------- 品牌 hero ---------- */
.hero {
  position: relative;
  overflow: hidden;
  background: var(--mc-ink);
  color: #fff;
}

/* 金色"金拱门"弧线装饰：两个半圆描边，低透明度不干扰文字 */
.hero::before,
.hero::after {
  content: '';
  position: absolute;
  top: -70px;
  width: 190px;
  height: 190px;
  border: 26px solid var(--mc-gold);
  border-bottom-color: transparent;
  border-radius: 50%;
  opacity: 0.22;
  pointer-events: none;
}

.hero::before {
  right: 8%;
  transform: rotate(-12deg);
}

.hero::after {
  right: 18%;
  transform: rotate(8deg) scale(0.72);
}

.hero-inner {
  position: relative;
  max-width: 1200px;
  margin: 0 auto;
  padding: 44px 32px 40px;
}

.hero-title {
  margin: 0;
  font-size: 34px;
  font-weight: 800;
  letter-spacing: 1px;
}

/* "减脂营养师"用品牌金，与墨底对比度约 12:1，无障碍达标 */
.hero-title-accent {
  color: var(--mc-gold);
}

.hero-tagline {
  margin: 12px 0 0;
  max-width: 560px;
  font-size: 15px;
  line-height: 1.7;
  color: #f3efe6;
}

.hero-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 18px;
}

/* 数据来源徽章：金底墨字，对比度约 11:1 */
.source-badge {
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--mc-gold);
  color: var(--mc-ink);
  font-size: 13px;
  font-weight: 700;
}

.source-badge--sub {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: #f3efe6;
  font-weight: 400;
}

/* ---------- 主内容区 ---------- */
.app-main {
  flex: 1;
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 28px 32px 40px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.error-alert {
  border-radius: 12px;
}

.section-title {
  margin: 8px 0 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--mc-ink);
}

/* 方案卡片网格：宽屏 3 列，自动降列，<768px 单列 */
.plans-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 20px;
  align-items: start;
}

.comparison-wrap,
.query-wrap {
  border-radius: 14px;
}

/* ---------- 页脚 ---------- */
.app-footer {
  background: var(--mc-ink);
  color: #d8d3c8;
  padding: 28px 32px 32px;
}

.footer-title {
  max-width: 1200px;
  margin: 0 auto 12px;
  font-size: 15px;
  color: var(--mc-gold);
}

.footer-list {
  max-width: 1200px;
  margin: 0 auto;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.9;
}

.footer-list b {
  color: #fff;
}

.footer-copy {
  max-width: 1200px;
  margin: 16px auto 0;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.15);
  font-size: 12px;
  color: #9b968b;
}

/* ---------- 响应式：<768px 全面单列 ---------- */
@media (max-width: 768px) {
  .hero-inner {
    padding: 32px 20px 28px;
  }

  .hero-title {
    font-size: 26px;
  }

  .hero::before,
  .hero::after {
    display: none; /* 窄屏隐藏装饰，保证文字可读 */
  }

  .app-main {
    padding: 20px 16px 32px;
  }

  .plans-grid {
    grid-template-columns: 1fr;
  }
}
</style>
