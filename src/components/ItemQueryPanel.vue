<script setup>
/**
 * 单品查询面板（Task 7.3）
 * 关键词搜索菜单快照，展示每个单品的营养明细、价格（门店菜单匹配价，
 * 未收录显示"未公开"）与过敏原（推断）+ 推断依据。
 */
import { computed, ref } from 'vue'
import { searchItems } from '../services/mcpClient.js'

const keyword = ref('')

// searchItems 为同步调用：菜单缓存未就绪时回退到内置快照
const results = computed(() => searchItems(keyword.value))

/** 餐段中文映射：breakfast→早餐供应，allDay→全天供应 */
const PERIOD_LABEL = { breakfast: '早餐供应', allDay: '全天供应' }

/** 过敏原单元格文案：null 表示官方接口未声明且无法推断 → 显示"未知" */
function allergenText(row) {
  if (row.allergens == null) return '未知（官方未声明）'
  if (row.allergens.length === 0) return '无'
  return row.allergens.join('、')
}

/** 价格单元格文案：门店菜单未收录（null）时显示"未公开" */
function priceText(row) {
  return row.price == null ? '未公开' : `¥${row.price}`
}
</script>

<template>
  <el-card class="query-card" shadow="hover">
    <template #header>
      <div class="card-head">
        <span class="step-no">查</span>
        <h2 class="card-title">单品营养查询</h2>
        <span class="count-badge">共 {{ results.length }} 项</span>
      </div>
    </template>

    <el-input
      v-model="keyword"
      placeholder="搜索单品名称，如：麦辣鸡腿堡、薯条、拿铁"
      clearable
      size="large"
      class="search-input"
    >
      <template #prefix>
        <el-icon><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
          <path fill="currentColor" d="M909.6 854.5L649.9 594.8C690.2 542.7 714 478.4 714 410c0-167.4-135.6-303-303-303S108 242.6 108 410s135.6 303 303 303c68.4 0 132.7-23.8 184.8-64.1l259.7 259.7a8.2 8.2 0 0 0 11.6 0l42.5-42.5a8.2 8.2 0 0 0 0-11.6zM411 740c-182.1 0-330-147.9-330-330s147.9-330 330-330 330 147.9 330 330-147.9 330-330 330z" />
        </svg></el-icon>
      </template>
    </el-input>

    <p class="query-hint">
      数据来源：麦当劳 MCP 官方接口 list-nutrition-foods（160 个单品，2026-10-26 拉取）。价格来自 MCP 门店菜单（上海徐家汇餐厅，2026-10-26），未收录单品显示"未公开"；过敏原为推断数据，非官方声明。
    </p>

    <!-- 横向滚动容器：窄屏下表格不溢出 -->
    <div class="table-scroll">
      <el-table :data="results" size="small" border stripe max-height="520">
        <el-table-column prop="name" label="名称" min-width="150" fixed />
        <el-table-column prop="category" label="分类" width="110" />
        <el-table-column label="餐段" width="100">
          <template #default="{ row }">{{ PERIOD_LABEL[row.mealPeriod] ?? row.mealPeriod }}</template>
        </el-table-column>
        <el-table-column label="热量" width="88" align="right">
          <template #default="{ row }">{{ row.calories ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="蛋白" width="72" align="right">
          <template #default="{ row }">{{ row.protein ?? '—' }}g</template>
        </el-table-column>
        <el-table-column label="碳水" width="72" align="right">
          <template #default="{ row }">{{ row.carbs ?? '—' }}g</template>
        </el-table-column>
        <el-table-column label="脂肪" width="72" align="right">
          <template #default="{ row }">{{ row.fat ?? '—' }}g</template>
        </el-table-column>
        <el-table-column label="钠" width="72" align="right">
          <template #default="{ row }">{{ row.sodium ?? '—' }}mg</template>
        </el-table-column>
        <el-table-column label="价格" width="80" align="center">
          <template #default="{ row }">
            <span :class="row.price == null ? 'muted' : ''">{{ priceText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="过敏原（推断）" min-width="200">
          <template #default="{ row }">
            <div class="allergen-cell">
              <template v-if="row.allergens == null">
                <el-tag size="small" type="warning" effect="plain">未知</el-tag>
              </template>
              <template v-else-if="row.allergens.length === 0">
                <span class="muted">无</span>
              </template>
              <template v-else>
                <el-tag
                  v-for="a in row.allergens"
                  :key="a"
                  size="small"
                  effect="plain"
                  class="allergen-tag"
                >
                  {{ a }}
                </el-tag>
              </template>
              <div v-if="row.allergenBasis" class="basis">{{ row.allergenBasis }}</div>
              <div v-if="row.allergens == null" class="basis">官方未声明，无法推断</div>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </el-card>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 26px;
  padding: 0 10px;
  border-radius: 13px;
  background: var(--mc-red);
  color: #fff;
  font-weight: 700;
  font-size: 13px;
}

.card-title {
  margin: 0;
  font-size: 18px;
  color: var(--mc-ink);
  flex: 1;
}

.count-badge {
  padding: 3px 10px;
  border-radius: 999px;
  background: #fff8e1;
  color: var(--mc-ink);
  font-size: 12px;
  font-weight: 600;
}

.search-input {
  margin-bottom: 12px;
}

.query-hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--mc-muted);
  line-height: 1.6;
}

.muted {
  color: var(--mc-muted);
}

.allergen-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.allergen-tag {
  margin-right: 4px;
}

/* 过敏原推断依据：小字灰色 */
.basis {
  font-size: 11px;
  color: var(--mc-muted);
  line-height: 1.5;
}
</style>
