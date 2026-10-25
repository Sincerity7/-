<script setup>
/**
 * 用户画像表单（Task 7.1）
 * 收集身体数据 / 活动量 / 每日热量上限 / 忌口偏好，
 * 必填校验通过后通过 submit 事件把画像交给父组件（App.vue）生成方案。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ACTIVITY_LEVELS, calcBMR, calcTDEE } from '../utils/nutrition.js'

/**
 * 过敏原枚举（10 项）。
 * 用词必须与菜单快照 items[].allergens 完全一致：
 * filterSafe 采用精确字符串匹配，用词不一致会导致过滤失效。
 */
const ALLERGEN_OPTIONS = [
  '麸质',
  '牛奶',
  '鸡蛋',
  '鱼类',
  '甲壳类',
  '花生',
  '坚果及其果仁类制品',
  '大豆',
  '猪肉',
  '牛肉',
]

defineProps({
  // 父组件生成中状态：驱动"生成减脂方案"按钮的 loading 态
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['submit'])

const formRef = ref(null)

const form = reactive({
  gender: '',
  // 年龄可选：留空时按 30 岁参与 BMR 计算
  // （Mifflin-St Jeor 公式含年龄项，nutrition.js 的 calcBMR 对 age 缺省值即为 30）
  age: null,
  heightCm: null,
  weightKg: null,
  activity: '',
  targetCalories: null,
  allergens: [],
  customKeywords: [],
})

/** Element Plus 校验规则：必填项缺失时逐项中文提示并阻止生成 */
const rules = {
  gender: [{ required: true, message: '请选择性别', trigger: 'change' }],
  age: [
    {
      // 年龄为可选项：仅在填写时校验合理区间
      validator: (_rule, value, callback) => {
        if (value != null && (value < 10 || value > 100)) {
          callback(new Error('年龄需在 10-100 岁之间'))
        } else {
          callback()
        }
      },
      trigger: 'change',
    },
  ],
  heightCm: [
    { required: true, message: '请输入身高（cm）', trigger: 'change' },
    { type: 'number', min: 100, max: 250, message: '身高需在 100-250cm 之间', trigger: 'change' },
  ],
  weightKg: [
    { required: true, message: '请输入体重（kg）', trigger: 'change' },
    { type: 'number', min: 25, max: 300, message: '体重需在 25-300kg 之间', trigger: 'change' },
  ],
  activity: [{ required: true, message: '请选择日常活动量', trigger: 'change' }],
  targetCalories: [
    { required: true, message: '请输入每日热量上限（kcal）', trigger: 'change' },
    {
      type: 'number',
      min: 500,
      max: 6000,
      message: '每日热量上限建议在 500-6000kcal 之间',
      trigger: 'change',
    },
  ],
}

/** 实时估算条件：性别/身高/体重/活动量齐备（年龄可缺省按 30 岁） */
const canEstimate = computed(
  () => !!form.gender && !!form.heightCm && !!form.weightKg && !!form.activity
)

const profileForCalc = computed(() => ({
  gender: form.gender,
  heightCm: form.heightCm,
  weightKg: form.weightKg,
  age: form.age ?? 30,
  activity: form.activity,
}))

/** 实时 BMR（基础代谢率，kcal/天，四舍五入） */
const bmr = computed(() => (canEstimate.value ? Math.round(calcBMR(profileForCalc.value)) : null))
/** 实时 TDEE（每日总能量消耗，kcal/天） */
const tdee = computed(() => (canEstimate.value ? calcTDEE(profileForCalc.value) : null))

/** 填入减脂参考值：target = round(TDEE × 0.8)，制造约 20% 热量缺口 */
function fillFatLossTarget() {
  if (tdee.value == null) return
  form.targetCalories = Math.round(tdee.value * 0.8)
}

/* ---------- 自定义忌口：动态 el-tag 输入（按餐品名称子串匹配剔除） ---------- */
const kwInput = ref('')

function addKeyword() {
  const kw = kwInput.value.trim()
  if (!kw) return
  if (form.customKeywords.includes(kw)) {
    ElMessage.warning(`忌口词「${kw}」已存在`)
  } else {
    form.customKeywords.push(kw)
  }
  kwInput.value = ''
}

function removeKeyword(index) {
  form.customKeywords.splice(index, 1)
}

/* ---------- 提交 ---------- */
async function handleSubmit() {
  if (!formRef.value) return
  // 校验失败时 Element Plus 在各表单项下显示中文错误，并阻止生成
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  emit('submit', {
    gender: form.gender,
    // 年龄留空时按 30 岁提交，与 calcBMR 缺省口径一致
    age: form.age ?? 30,
    heightCm: form.heightCm,
    weightKg: form.weightKg,
    activity: form.activity,
    targetCalories: form.targetCalories,
    allergens: [...form.allergens],
    customKeywords: [...form.customKeywords],
  })
}
</script>

<template>
  <el-card class="profile-card" shadow="hover">
    <template #header>
      <div class="card-head">
        <span class="step-no">1</span>
        <h2 class="card-title">填写你的画像与忌口</h2>
      </div>
    </template>

    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      @submit.prevent
    >
      <div class="form-grid">
        <!-- 性别：影响 BMR 公式常数项 -->
        <el-form-item label="性别" prop="gender">
          <el-radio-group v-model="form.gender">
            <el-radio value="男">男</el-radio>
            <el-radio value="女">女</el-radio>
          </el-radio-group>
        </el-form-item>

        <!-- 年龄：可选，留空按 30 岁参与 BMR 计算 -->
        <el-form-item prop="age">
          <template #label>
            年龄（岁）
            <span class="optional-hint">选填，缺省 30</span>
          </template>
          <el-input-number
            v-model="form.age"
            :min="10"
            :max="100"
            :step="1"
            controls-position="right"
            placeholder="如 28"
            class="num-input"
          />
        </el-form-item>

        <el-form-item label="身高（cm）" prop="heightCm">
          <el-input-number
            v-model="form.heightCm"
            :min="100"
            :max="250"
            :step="1"
            controls-position="right"
            placeholder="如 175"
            class="num-input"
          />
        </el-form-item>

        <el-form-item label="体重（kg）" prop="weightKg">
          <el-input-number
            v-model="form.weightKg"
            :min="25"
            :max="300"
            :step="0.5"
            :precision="1"
            controls-position="right"
            placeholder="如 70.5"
            class="num-input"
          />
        </el-form-item>

        <el-form-item label="日常活动量" prop="activity">
          <el-select v-model="form.activity" placeholder="请选择活动量档位" class="full-select">
            <el-option
              v-for="level in ACTIVITY_LEVELS"
              :key="level.key"
              :label="level.label"
              :value="level.key"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="每日热量上限（kcal）" prop="targetCalories">
          <el-input-number
            v-model="form.targetCalories"
            :min="500"
            :max="6000"
            :step="50"
            controls-position="right"
            placeholder="如 1600"
            class="num-input"
          />
        </el-form-item>
      </div>

      <!-- BMR / TDEE 实时参考：填齐性别/身高/体重/活动量后即时显示 -->
      <transition name="fade">
        <div v-if="canEstimate" class="estimate-strip">
          <div class="stat">
            <span class="stat-label">BMR 基础代谢</span>
            <span class="stat-value">{{ bmr }}<small> kcal/天</small></span>
          </div>
          <div class="stat">
            <span class="stat-label">TDEE 每日总消耗</span>
            <span class="stat-value">{{ tdee }}<small> kcal/天</small></span>
          </div>
          <el-button type="warning" plain @click="fillFatLossTarget">
            填入减脂参考值（TDEE×0.8）
          </el-button>
        </div>
      </transition>

      <!-- 过敏原多选：用词与快照 allergens 枚举严格一致 -->
      <el-form-item class="span-all">
        <template #label>
          过敏原（多选，命中即从候选中剔除）
          <span class="optional-hint">过敏原数据为推断，非官方声明</span>
        </template>
        <el-checkbox-group v-model="form.allergens" class="allergen-group">
          <el-checkbox v-for="a in ALLERGEN_OPTIONS" :key="a" :value="a" border>
            {{ a }}
          </el-checkbox>
        </el-checkbox-group>
      </el-form-item>

      <!-- 自定义忌口：动态标签，按餐品名称子串匹配剔除 -->
      <el-form-item label="自定义忌口（匹配餐品名称，回车添加）" class="span-all">
        <div class="kw-zone">
          <el-tag
            v-for="(kw, i) in form.customKeywords"
            :key="kw"
            closable
            type="warning"
            effect="light"
            @close="removeKeyword(i)"
          >
            {{ kw }}
          </el-tag>
          <el-input
            v-model="kwInput"
            size="small"
            placeholder="如：香菜、洋葱、内脏"
            class="kw-input"
            @keyup.enter="addKeyword"
            @blur="addKeyword"
          />
        </div>
      </el-form-item>

      <div class="submit-zone">
        <el-button type="primary" size="large" :loading="loading" @click="handleSubmit">
          生成减脂方案
        </el-button>
        <p class="submit-hint">将按「早30% / 午40% / 晚30%」配额生成三套策略方案，总热量控制在目标 ±5%</p>
      </div>
    </el-form>
  </el-card>
</template>

<style scoped>
/* 卡片头：步骤序号用品牌金底墨字，强化流程感 */
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--mc-gold);
  color: var(--mc-ink);
  font-weight: 700;
  font-size: 14px;
}

.card-title {
  margin: 0;
  font-size: 18px;
  color: var(--mc-ink);
}

/* 双列表单网格：<768px 收为单列 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 20px;
}

.num-input,
.full-select {
  width: 100%;
}

.optional-hint {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--mc-muted);
}

/* BMR / TDEE 实时参考条：奶油底 + 金色左边框 */
.estimate-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px 28px;
  margin: 4px 0 18px;
  padding: 12px 16px;
  background: #fff8e1;
  border: 1px solid #f3e2a6;
  border-left: 4px solid var(--mc-gold);
  border-radius: 10px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-label {
  font-size: 12px;
  color: var(--mc-muted);
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--mc-red);
  font-variant-numeric: tabular-nums;
}

.stat-value small {
  font-size: 12px;
  font-weight: 400;
  color: var(--mc-muted);
}

/* 过敏原多选区 */
.allergen-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 自定义忌口标签区 */
.kw-zone {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.kw-input {
  width: 180px;
}

/* 生成按钮区 */
.submit-zone {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 4px;
}

.submit-hint {
  margin: 0;
  font-size: 12px;
  color: var(--mc-muted);
}

/* 淡入过渡 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 768px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .estimate-strip {
    gap: 10px 16px;
  }
}
</style>
