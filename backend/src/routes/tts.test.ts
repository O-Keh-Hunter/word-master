import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ttsRouter from './tts'
import { synthesizeLocal } from '../services/local-speech'
import { synthesize as synthesizeXunfei } from '../services/xunfei/tts'

vi.mock('../services/local-speech', () => ({ synthesizeLocal: vi.fn(async () => Buffer.from('RIFF0000WAVEtest')) }))
vi.mock('../services/xunfei/tts', () => ({ synthesize: vi.fn(async () => Buffer.from('mp3-audio')) }))
const app = express().use(express.json()).use('/api/tts', ttsRouter)
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('TTS_PROVIDER', 'local') })
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
  it.each([{ text: 12 }, { text: ' ' }, { text: 'a'.repeat(501) }, { text: 'apple', vcn: 12 }])
    ('rejects malformed synthesis requests: %j', async body => {
      expect((await request(app).post('/api/tts').send(body)).status).toBe(400)
      expect(synthesizeLocal).not.toHaveBeenCalled()
    })
})
