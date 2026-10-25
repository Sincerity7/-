// 应用入口：创建 Vue 实例并全量引入 Element Plus
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'

const app = createApp(App)

// 全量注册 Element Plus 组件
app.use(ElementPlus)

app.mount('#app')
