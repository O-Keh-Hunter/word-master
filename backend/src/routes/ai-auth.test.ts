import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import router from './ai-auth'
import { beginAntigravityLogin, completeAntigravityLogin, disconnectAntigravity, getAntigravityStatus } from '../services/antigravity-auth'

vi.mock('../services/antigravity-auth', () => ({
  beginAntigravityLogin: vi.fn(async () => ({ url: 'https://accounts.google.com/', automaticCallback: true })),
  completeAntigravityLogin: vi.fn(async () => {}),
  disconnectAntigravity: vi.fn(),
  getAntigravityStatus: vi.fn(() => ({ connected: false, email: null, model: 'gemini-3-flash' })),
}))
const app = express().use(express.json()).use('/api/ai-auth', router)
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => vi.unstubAllEnvs())

describe('AI account administration', () => {
  it('returns status directly and uncacheable without password', async () => {
    const response = await request(app).get('/api/ai-auth/status')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ connected: false, email: null, model: 'gemini-3-flash' })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(getAntigravityStatus).toHaveBeenCalledOnce()
  })
  it('validates the manual callback before attempting exchange', async () => {
    const response = await request(app).post('/api/ai-auth/complete').send({ callbackUrl: 12 })
    expect(response.status).toBe(400)
    expect(completeAntigravityLogin).not.toHaveBeenCalled()
  })
  it('allows starting and disconnecting login directly', async () => {
    expect((await request(app).post('/api/ai-auth/login').send({})).status).toBe(200)
    expect((await request(app).post('/api/ai-auth/disconnect').send({})).status).toBe(200)
    expect(beginAntigravityLogin).toHaveBeenCalledOnce()
    expect(disconnectAntigravity).toHaveBeenCalledOnce()
  })
})
