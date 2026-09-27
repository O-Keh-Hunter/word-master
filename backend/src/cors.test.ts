import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from './app'

afterEach(() => vi.unstubAllEnvs())

describe('deployment CORS', () => {
  it('permits same-origin POSTs behind a TLS reverse proxy', async () => {
    vi.stubEnv('AI_ADMIN_PASSWORD', 'test-password')
    const response = await request(app).post('/api/ai-auth/complete')
      .set('Host', 'words.example.com').set('Origin', 'https://words.example.com')
      .set('X-AI-Admin-Password', 'test-password').send({ callbackUrl: 12 })
    expect(response.status).toBe(400) // Reaches route input validation, not CORS rejection.
    expect(response.headers['access-control-allow-origin']).toBe('https://words.example.com')
  })
  it('permits existing local development origins', async () => {
    const response = await request(app).get('/api/health').set('Origin', 'https://localhost:5173')
    expect(response.status).toBe(200)
  })
  it('does not grant CORS to a different origin', async () => {
    vi.stubEnv('CORS_ORIGIN', '')
    const response = await request(app).get('/api/health')
      .set('Host', 'words.example.com').set('Origin', 'https://attacker.example.com')
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.status).toBe(500)
  })
})
