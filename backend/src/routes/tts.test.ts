import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ttsRouter from './tts'
import { synthesizeLocal } from '../services/local-speech'
import { synthesize as synthesizeXunfei } from '../services/xunfei/tts'
import { synthesizeSuper } from '../services/xunfei/super-tts'

vi.mock('../services/local-speech', () => ({ synthesizeLocal: vi.fn(async () => Buffer.from('RIFF0000WAVEtest')) }))
vi.mock('../services/xunfei/tts', () => ({ synthesize: vi.fn(async () => Buffer.from('mp3-audio')) }))
vi.mock('../services/xunfei/super-tts', () => ({ synthesizeSuper: vi.fn(async () => Buffer.from('super-mp3-audio')) }))
const app = express().use(express.json()).use('/api/tts', ttsRouter)
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('TTS_PROVIDER', 'local')
  vi.stubEnv('XUNFEI_SUPER_EN_VOICE', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('TTS provider and audio response', () => {
  it('returns WAV for the default local provider', async () => {
    const response = await request(app).post('/api/tts').send({ text: 'apple' })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('audio/wav')
    expect(synthesizeLocal).toHaveBeenCalledWith('apple', undefined)
    expect(synthesizeXunfei).not.toHaveBeenCalled()
  })
  it('retains MP3 for explicit Xunfei deployments', async () => {
    vi.stubEnv('TTS_PROVIDER', 'xunfei')
    const response = await request(app).post('/api/tts').send({ text: '你好', vcn: 'xiaoyan' })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('audio/mpeg')
    expect(synthesizeXunfei).toHaveBeenCalledWith('你好', 'xiaoyan')
  })
  it.each([{ text: '你好' }, { text: '你好', vcn: 'xiaoyan' }, { text: 'Hello，你好' }])
    ('uses super synthesis for Chinese in hybrid mode: %j', async body => {
      vi.stubEnv('TTS_PROVIDER', 'xunfei-hybrid')
      const response = await request(app).post('/api/tts').send(body)
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toBe('audio/mpeg')
      expect(synthesizeSuper).toHaveBeenCalledWith(body.text)
      expect(synthesizeXunfei).not.toHaveBeenCalled()
      expect(synthesizeLocal).not.toHaveBeenCalled()
    })
  it('keeps standard English until a super voice is configured', async () => {
    vi.stubEnv('TTS_PROVIDER', 'xunfei-hybrid')
    expect((await request(app).post('/api/tts').send({ text: 'apple' })).status).toBe(200)
    expect(synthesizeXunfei).toHaveBeenCalledWith('apple', undefined)
    expect(synthesizeSuper).not.toHaveBeenCalled()
  })
  it('switches English to the configured super voice', async () => {
    vi.stubEnv('TTS_PROVIDER', 'xunfei-hybrid')
    vi.stubEnv('XUNFEI_SUPER_EN_VOICE', 'x5_EnUs_Lila_flow')
    expect((await request(app).post('/api/tts').send({ text: 'apple', vcn: 'aisxping' })).status).toBe(200)
    expect(synthesizeSuper).toHaveBeenCalledWith('apple', 'x5_EnUs_Lila_flow')
    expect(synthesizeXunfei).not.toHaveBeenCalled()
  })
  it('reports super voice failures without silently changing providers', async () => {
    vi.stubEnv('TTS_PROVIDER', 'xunfei-hybrid')
    vi.mocked(synthesizeSuper).mockRejectedValueOnce(new Error('未授权（11200）'))
    const response = await request(app).post('/api/tts').send({ text: '你好' })
    expect(response.status).toBe(500)
    expect(response.body.error).toContain('11200')
    expect(synthesizeXunfei).not.toHaveBeenCalled()
    expect(synthesizeLocal).not.toHaveBeenCalled()
  })
  it.each([{ text: 12 }, { text: ' ' }, { text: 'a'.repeat(501) }, { text: 'apple', vcn: 12 }])
    ('rejects malformed synthesis requests: %j', async body => {
      expect((await request(app).post('/api/tts').send(body)).status).toBe(400)
      expect(synthesizeLocal).not.toHaveBeenCalled()
    })
})
