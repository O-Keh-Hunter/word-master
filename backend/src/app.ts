import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { initSchema } from './db/schema'
import studentsRouter from './routes/students'
import wordbooksRouter from './routes/wordbooks'
import quizRouter from './routes/quiz'
import recordsRouter from './routes/records'
import ttsRouter from './routes/tts'
import sttRouter from './routes/stt'
import semanticRouter from './routes/semantic'
import plansRouter from './routes/plans'
import tasksRouter from './routes/tasks'
import petRouter from './routes/pet'
import aiAuthRouter from './routes/ai-auth'

dotenv.config()

import { setGlobalDispatcher, ProxyAgent } from 'undici'
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
if (proxyUrl) {
  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl))
    console.log(`[proxy] 全局代理已启用: ${proxyUrl}`)
  } catch (err) {
    console.warn('[proxy] 全局代理初始化失败:', (err as Error).message)
  }
}

const app = express()

app.use(cors((req, callback) => callback(null, {
  origin: (origin, cb) => {
    const extra = process.env.CORS_ORIGIN
    // Browsers send Origin even for same-origin POSTs and module scripts.
    // Compare the authority; TLS may terminate at the reverse proxy.
    let sameOrigin = false
    try {
      const url = new URL(origin || '')
      sameOrigin = /^https?:$/.test(url.protocol) && url.host === req.headers.host
    } catch { /* Missing or invalid Origin is handled below. */ }
    if (
      !origin ||
      sameOrigin ||
      (extra && origin === extra) ||
      /^https?:\/\/(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+):5173$/.test(origin)
    ) {
      cb(null, true)
    } else {
      cb(new Error('Not allowed by CORS'))
    }
  },
})))
app.use(express.json())

// 初始化数据库表结构
initSchema()

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() })
})

app.use('/api/students', studentsRouter)
app.use('/api/wordbooks', wordbooksRouter)
app.use('/api/quiz', quizRouter)
app.use('/api/records', recordsRouter)
app.use('/api/tts', ttsRouter)
app.use('/api/stt', sttRouter)
app.use('/api/semantic', semanticRouter)
app.use('/api/plans', plansRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/pet', petRouter)
app.use('/api/ai-auth', aiAuthRouter)

// 生产模式：托管前端构建产物，所有非 /api 请求返回 index.html（SPA fallback）
if (process.env.NODE_ENV === 'production') {
  const frontendDist = path.resolve(__dirname, '../frontend-dist')
  // 子路径部署时通过 APP_BASE_PATH 指定挂载路径
  // 需与前端构建时传入的 VITE_BASE_URL 保持一致，默认根路径 /
  const basePath = (process.env.APP_BASE_PATH || '/').replace(/\/+$/, '') || ''
  app.use(basePath, express.static(frontendDist))
  app.get(`${basePath}/*`, (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'))
  })
}

export default app
