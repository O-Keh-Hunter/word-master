import { Router } from 'express'
import {
  beginAntigravityLogin, completeAntigravityLogin, disconnectAntigravity, getAntigravityStatus,
} from '../services/antigravity-auth'

const router = Router()

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
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
    console.error('[ai-auth] complete failed:', (error as Error).message)
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
