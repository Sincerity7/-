<script setup>
/**
 * 方案卡片（Task 7.2 / 7.3）
 * 上半部：用 marked 渲染 renderPlanMarkdown 生成的方案 Markdown（含营养汇总表格）；
 * 下半部：可交互单品表，支持"不喜欢→自动替换"与"还原"。
 * 替换/还原走 substitute.js 的不可变接口，只更新组件内部副本，
 * 并通过 change 事件把最新方案同步回父组件（保持对比表一致）。
 */
import { computed, ref, watch } from 'vue'
import { marked } from 'marked'
import { ElMessage } from 'element-plus'
import { renderPlanMarkdown } from '../utils/markdownOutput.js'
import { findSubstitute, applySubstitute, restoreOriginal } from '../utils/substitute.js'

const props = defineProps({
  // 方案对象：{strategy, label, meals:[{period, items}], totals}
  plan: { type: Object, required: true },
  // 全量菜单单品：findSubstitute 的候选池
  items: { type: Array, default: () => [] },
  // 用户忌口：替换候选同样需通过过敏原/自定义忌口过滤
  allergens: { type: Array, default: () => [] },
  customKeywords: { type: Array, default: () => [] },
  // 每日热量上限：替换后整套仍需落在 ±5% 内
  targetCalories: { type: Number, required: true },
})

const emit = defineEmits(['change'])

// 本地副本：替换/还原只改本地（substitute.js 保证不可变，浅拷贝即可）
const localPlan = ref({ ...props.plan })
watch(
  () => props.plan,
  (p) => {
    localPlan.value = { ...p }
  }
)

/** 策略展示元信息：卡片角标名称与色调 */
const STRATEGY_META = {
  lowcal: { name: '控卡优先', tone: 'red' },
  value: { name: '性价比优先', tone: 'gold' },
  satiety: { name: '饱腹感优先', tone: 'ink' },
}

const strategyMeta = computed(
  () => STRATEGY_META[localPlan.value.strategy] ?? { name: localPlan.value.strategy ?? '方案', tone: 'ink' }
)

/** 餐段中文映射 */
const PERIOD_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }

// Markdown → HTML（marked 默认同步解析）
const planHtml = computed(() => marked.parse(renderPlanMarkdown(localPlan.value)))

// 展平单品行：交互表格的数据源，保留 mealIndex/itemIndex 定位
const rows = computed(() => {
  const out = []
  ;(localPlan.value.meals ?? []).forEach((meal, mealIndex) => {
    ;(meal.items ?? []).forEach((item, itemIndex) => {
      out.push({
        mealIndex,
        itemIndex,
        key: `${mealIndex}:${itemIndex}`,
        period: PERIOD_LABEL[meal.period] ?? meal.period,
        name: item.name,
        calories: item.calories,
      })
    })
  })
  return out
})

/** 该行是否发生过替换（plan.originalItems 记录了原单品） */
function isReplaced(key) {
  return !!(localPlan.value.originalItems && localPlan.value.originalItems[key])
}

// 正在替换中的行 key：按钮 loading，防重复点击
const busyKey = ref('')

/** 不喜欢→自动替换：同类型、热量±10%、忌口安全且替换后整套达标的最优候选 */
function handleSubstitute(row) {
  if (busyKey.value) return
  busyKey.value = row.key
  try {
    const candidate = findSubstitute({
      plan: localPlan.value,
      mealIndex: row.mealIndex,
      itemIndex: row.itemIndex,
      items: props.items,
      allergens: props.allergens,
      customKeywords: props.customKeywords,
      targetCalories: props.targetCalories,
    })
    if (!candidate) {
      ElMessage.warning('当前条件下无可替换单品（同类型、热量±10%、达标）')
      return
    }
    // applySubstitute 返回新 plan 并重算 totals，markdown 与汇总随之重新渲染
    localPlan.value = applySubstitute(localPlan.value, row.mealIndex, row.itemIndex, candidate)
    ElMessage.success(`已替换为「${candidate.name}」`)
    emit('change', { ...localPlan.value })
  } finally {
    busyKey.value = ''
  }
}

/** 还原：restoreOriginal 一次性还原本卡全部替换记录 */
function handleRestore() {
  localPlan.value = restoreOriginal(localPlan.value)
  ElMessage.info('已还原为原始方案')
  emit('change', { ...localPlan.value })
}

// 过敏原未知单品：卡片内显示确认提示
const hasUnknownAllergen = computed(() =>
  (localPlan.value.meals ?? []).some((m) =>
    (m.items ?? []).some((it) => it.allergenUnknown || it.allergens == null)
  )
)

/** 已替换行高亮 */
function rowClassName({ row }) {
  return isReplaced(row.key) ? 'replaced-row' : ''
}
</script>

<template>
  <el-card class="plan-card" shadow="hover" :class="`plan-card--${strategyMeta.tone}`">
    <template #header>
      <div class="card-head">
        <span class="strategy-chip" :class="`chip--${strategyMeta.tone}`">{{ strategyMeta.name }}</span>
        <span class="strategy-label">{{ localPlan.label }}</span>
      </div>
    </template>

    <!-- 方案 Markdown 预览（表格样式由全局 .markdown-body 美化） -->
    <div class="markdown-body table-scroll" v-html="planHtml"></div>

    <!-- 过敏原未知提示 -->
    <el-alert
      v-if="hasUnknownAllergen"
      class="unknown-alert"
      type="warning"
      :closable="false"
      show-icon
      title="部分餐品过敏原未知，请自行确认"
    />

    <el-divider content-position="left">
      <span class="divider-text">单品微调</span>
    </el-divider>

    <!-- 可交互单品列表：不喜欢→自动替换 / 已替换行可还原 -->
    <el-table :data="rows" size="small" row-key="key" :row-class-name="rowClassName">
      <el-table-column prop="period" label="餐段" width="64" />
      <el-table-column prop="name" label="名称" min-width="150" show-overflow-tooltip />
      <el-table-column label="热量" width="88" align="right">
        <template #default="{ row }">{{ row.calories }} kcal</template>
      </el-table-column>
      <el-table-column label="操作" width="176" align="right">
        <template #default="{ row }">
          <el-button
            size="small"
            type="primary"
            plain
            :loading="busyKey === row.key"
            @click="handleSubstitute(row)"
          >
            不喜欢→自动替换
          </el-button>
          <el-tooltip
            v-if="isReplaced(row.key)"
            content="还原本卡全部替换"
            placement="top"
          >
            <el-button size="small" text type="info" @click="handleRestore">还原</el-button>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
/* 卡片顶边按策略色调区分：红=控卡、金=性价比、墨=饱腹 */
.plan-card {
  border-top: 4px solid var(--mc-ink);
  border-radius: 14px;
}

.plan-card--red {
  border-top-color: var(--mc-red);
}

.plan-card--gold {
  border-top-color: var(--mc-gold);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 策略角标：金底墨字 / 红底白字 */
.strategy-chip {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}

.chip--red {
  background: var(--mc-red);
  color: #fff;
}

.chip--gold {
  background: var(--mc-gold);
  color: var(--mc-ink);
}

.chip--ink {
  background: var(--mc-ink);
  color: #fff;
}

.strategy-label {
  font-size: 12px;
  color: var(--mc-muted);
  line-height: 1.4;
}

.unknown-alert {
  margin-top: 12px;
}

.divider-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--mc-ink);
}

/* 已替换行：金色底高亮 */
:deep(.replaced-row) .el-table__cell {
  background: #fff6d8;
}
</style>
