import { Router } from 'express'
import { synthesize } from '../services/tts'

const router = Router()

router.post('/', async (req, res) => {
  const { text, vcn } = (req.body || {}) as { text?: string; vcn?: string }
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text 不能为空' })
    return
  }
  if (text.trim().length > 500 || (vcn !== undefined && typeof vcn !== 'string')) {
    res.status(400).json({ error: '朗读文本不能超过 500 字符，发音人必须为字符串' })
    return
  }
  try {
    const audio = await synthesize(text.trim(), vcn)
    res.set('Content-Type', audio.contentType)
    res.send(audio.data)
  } catch (e) {
    console.error('TTS error:', e)
    res.status(500).json({ error: (e as Error).message })
  }
})

export default router
