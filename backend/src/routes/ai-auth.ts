import { createHash, timingSafeEqual } from 'crypto'
import { Router } from 'express'
import {
  beginAntigravityLogin, completeAntigravityLogin, disconnectAntigravity, getAntigravityStatus,
} from '../services/antigravity-auth'

const router = Router()

// Existing student profiles are not authenticated administrators. Protect the
// shared AI account separately; credentials are never returned by these routes.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  const password = process.env.AI_ADMIN_PASSWORD
  if (!password) {
    res.status(503).json({ error: '请先在后端配置 AI_ADMIN_PASSWORD，再管理 AI 账号' })
    return
  }
  const supplied = req.get('X-AI-Admin-Password') || ''
  const hash = (value: string) => createHash('sha256').update(value).digest()
  if (!timingSafeEqual(hash(password), hash(supplied))) {
    res.status(401).json({ error: 'AI 管理密码不正确' })
    return
  }
  next()
})

router.get('/status', (_req, res) => {
  try { res.json(getAntigravityStatus()) }
  catch { res.status(500).json({ error: 'AI 账号文件无法读取，请断开后重新登录' }) }
})

router.post('/login', async (_req, res) => {
  try { res.json(await beginAntigravityLogin()) }
  catch { res.status(500).json({ error: '无法发起 Google 登录，请重试' }) }
})

router.post('/complete', async (req, res) => {
  const callbackUrl = req.body?.callbackUrl
  if (typeof callbackUrl !== 'string' || callbackUrl.length > 8192) {
    res.status(400).json({ error: '请粘贴完整的授权回调链接' })
    return
  }
  try {
    await completeAntigravityLogin(callbackUrl)
    res.json(getAntigravityStatus())
  } catch (error) {
    // Service errors never include raw token responses or callback URLs.
    res.status(400).json({ error: (error as Error).message })
  }
})

router.post('/disconnect', (_req, res) => {
  try {
    disconnectAntigravity()
    res.json(getAntigravityStatus())
  } catch { res.status(500).json({ error: '断开失败，请检查账号文件权限' }) }
})

export default router
