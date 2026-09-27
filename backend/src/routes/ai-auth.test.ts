import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import router from './ai-auth'
import { beginAntigravityLogin, completeAntigravityLogin, disconnectAntigravity } from '../services/antigravity-auth'

vi.mock('../services/antigravity-auth', () => ({
  beginAntigravityLogin: vi.fn(async () => ({ url: 'https://accounts.google.com/', automaticCallback: true })),
  completeAntigravityLogin: vi.fn(async () => {}),
  disconnectAntigravity: vi.fn(),
  getAntigravityStatus: vi.fn(() => ({ connected: false, email: null, model: 'gemini-3-flash' })),
}))
const app = express().use(express.json()).use('/api/ai-auth', router)
beforeEach(() => { vi.stubEnv('AI_ADMIN_PASSWORD', 'test-admin-password'); vi.clearAllMocks() })
afterEach(() => vi.unstubAllEnvs())

describe('AI account administration', () => {
  it.each(['login', 'complete', 'disconnect'])('denies unauthorized %s without touching account state', async action => {
    const response = await request(app).post(`/api/ai-auth/${action}`).send({})
    expect(response.status).toBe(401)
    expect(beginAntigravityLogin).not.toHaveBeenCalled()
    expect(completeAntigravityLogin).not.toHaveBeenCalled()
    expect(disconnectAntigravity).not.toHaveBeenCalled()
  })
  it('keeps status private and uncacheable', async () => {
    expect((await request(app).get('/api/ai-auth/status')).status).toBe(401)
    const response = await request(app).get('/api/ai-auth/status').set('X-AI-Admin-Password', 'test-admin-password')
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
  })
  it('disables management until a password is configured', async () => {
    vi.stubEnv('AI_ADMIN_PASSWORD', '')
    expect((await request(app).post('/api/ai-auth/login').send({})).status).toBe(503)
  })
  it('validates the manual callback before attempting exchange', async () => {
    const response = await request(app).post('/api/ai-auth/complete')
      .set('X-AI-Admin-Password', 'test-admin-password').send({ callbackUrl: 12 })
    expect(response.status).toBe(400)
    expect(completeAntigravityLogin).not.toHaveBeenCalled()
  })
  it('allows an administrator to start and disconnect login', async () => {
    expect((await request(app).post('/api/ai-auth/login').set('X-AI-Admin-Password', 'test-admin-password').send({})).status).toBe(200)
    expect((await request(app).post('/api/ai-auth/disconnect').set('X-AI-Admin-Password', 'test-admin-password').send({})).status).toBe(200)
    expect(beginAntigravityLogin).toHaveBeenCalledOnce()
    expect(disconnectAntigravity).toHaveBeenCalledOnce()
  })
})
