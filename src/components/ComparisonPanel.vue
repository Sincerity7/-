<script setup>
/**
 * 三套方案横向对比面板（Task 7.2 扩展）
 * 用 marked 渲染 renderComparisonMarkdown(plans) 生成的对比 Markdown 表格。
 * 表格样式由全局 .markdown-body 统一美化（斑马纹、对齐、分割线）。
 */
import { computed } from 'vue'
import { marked } from 'marked'
import { renderComparisonMarkdown } from '../utils/markdownOutput.js'

const props = defineProps({
  // 三套方案数组，任一方案替换后 App.vue 会同步更新此 prop
  plans: { type: Array, default: () => [] },
})

// Markdown → HTML（marked 默认同步解析）
const html = computed(() => marked.parse(renderComparisonMarkdown(props.plans)))
</script>

<template>
  <el-card class="comparison-card" shadow="hover">
    <template #header>
      <div class="card-head">
        <span class="step-no">对比</span>
        <h2 class="card-title">三套方案横向对比</h2>
      </div>
    </template>

    <!-- 横向滚动容器：窄屏下表格不溢出 -->
    <div class="markdown-body table-scroll" v-html="html"></div>
  </el-card>
</template>

<style scoped>
.comparison-card {
  border-top: 4px solid var(--mc-gold);
  border-radius: 14px;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  height: 26px;
  padding: 0 10px;
  border-radius: 13px;
  background: var(--mc-gold);
  color: var(--mc-ink);
  font-weight: 700;
  font-size: 13px;
}

.card-title {
  margin: 0;
  font-size: 18px;
  color: var(--mc-ink);
}
</style>
