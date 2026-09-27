import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginAntigravityLogin, completeAntigravityLogin, disconnectAntigravity,
  getAntigravityCredentials, getAntigravityStatus, REDIRECT_URI,
} from './antigravity-auth'

let directory: string
const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  vi.stubEnv('ANTIGRAVITY_CLIENT_ID', 'test-client-id')
  vi.stubEnv('ANTIGRAVITY_CLIENT_SECRET', 'test-client-secret')
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'word-master-oauth-'))
  vi.stubEnv('ANTIGRAVITY_AUTH_FILE', path.join(directory, 'account.json'))
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  disconnectAntigravity()
  fs.rmSync(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function successfulExchange(expiresIn = 3600) {
  fetchMock.mockResolvedValueOnce(json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: expiresIn }))
    .mockResolvedValueOnce(json({ cloudaicompanionProject: { id: 'my-project' } }))
    .mockResolvedValueOnce(json({ email: 'teacher@example.com' }))
}

async function callback() {
  const login = await beginAntigravityLogin()
  const authorization = new URL(login.url)
  const url = new URL(REDIRECT_URI)
  url.search = new URLSearchParams({ code: 'one-time-code', state: authorization.searchParams.get('state')! }).toString()
  return { authorization, url: url.toString() }
}

describe('Antigravity OAuth', () => {
  it.each(['ANTIGRAVITY_CLIENT_ID', 'ANTIGRAVITY_CLIENT_SECRET'])('rejects missing %s before starting login', async (key) => {
    vi.stubEnv(key, ' ')
    await expect(beginAntigravityLogin()).rejects.toThrow('请在服务端配置')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses PKCE, persists private credentials, and exposes only account status', async () => {
    const { authorization, url } = await callback()
    expect(authorization.origin).toBe('https://accounts.google.com')
    expect(authorization.searchParams.get('client_id')).toBe('test-client-id')
    expect(authorization.searchParams.has('client_secret')).toBe(false)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    successfulExchange()
    await completeAntigravityLogin(url)
    const form = fetchMock.mock.calls[0][1]!.body as URLSearchParams
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'))
      .toBe(authorization.searchParams.get('code_challenge'))
    expect(form.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(form.get('client_id')).toBe('test-client-id')
    expect(form.get('client_secret')).toBe('test-client-secret')
    expect(getAntigravityStatus()).toMatchObject({ connected: true, email: 'teacher@example.com', model: 'gemini-3-flash' })
    expect(JSON.stringify(getAntigravityStatus())).not.toContain('secret')
    expect(fs.statSync(process.env.ANTIGRAVITY_AUTH_FILE!).mode & 0o777).toBe(0o600)
    await expect(completeAntigravityLogin(url)).rejects.toThrow('过期或不匹配')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects a foreign callback origin, unknown state, and expired login before exchanging tokens', async () => {
    const { url } = await callback()
    await expect(completeAntigravityLogin(url.replace('localhost', 'attacker.example'))).rejects.toThrow('地址不正确')
    await expect(completeAntigravityLogin(`${REDIRECT_URI}?code=x&state=wrong`)).rejects.toThrow('不匹配')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
    await expect(completeAntigravityLogin(url)).rejects.toThrow('过期')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a newer login cancels the older login', async () => {
    const first = await callback()
    await callback()
    await expect(completeAntigravityLogin(first.url)).rejects.toThrow('不匹配')
  })

  it('handles denied authorization without contacting the token endpoint', async () => {
    const { url } = await callback()
    await expect(completeAntigravityLogin(`${url}&error=access_denied`)).rejects.toThrow('取消')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not persist credentials when the account lacks an assigned project', async () => {
    const { url } = await callback()
    fetchMock.mockResolvedValueOnce(json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }))
      .mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({}))
    await expect(completeAntigravityLogin(url)).rejects.toThrow('官方 Antigravity')
    expect(getAntigravityStatus().connected).toBe(false)
  })

  it('coalesces concurrent refreshes and preserves the existing refresh token', async () => {
    const { url } = await callback()
    successfulExchange(1)
    await completeAntigravityLogin(url)
    fetchMock.mockResolvedValueOnce(json({ access_token: 'new-access', expires_in: 3600 }))
    const accounts = await Promise.all([getAntigravityCredentials(), getAntigravityCredentials()])
    expect(accounts.map(a => a.accessToken)).toEqual(['new-access', 'new-access'])
    expect(accounts[0].refreshToken).toBe('refresh-secret')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const form = fetchMock.mock.calls[3][1]!.body as URLSearchParams
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('refresh-secret')
  })

  it('does not restore a disconnected account when a refresh completes later', async () => {
    const { url } = await callback()
    successfulExchange(1)
    await completeAntigravityLogin(url)
    let resolve!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done }))
    const refreshing = getAntigravityCredentials()
    disconnectAntigravity()
    resolve(json({ access_token: 'new-access', expires_in: 3600 }))
    await expect(refreshing).rejects.toThrow('账号已变更')
    expect(getAntigravityStatus().connected).toBe(false)
  })

  it('does not save a login that was disconnected during the token exchange', async () => {
    const { url } = await callback()
    let resolve!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done }))
      .mockResolvedValueOnce(json({ cloudaicompanionProject: 'my-project' }))
      .mockResolvedValueOnce(json({ email: 'teacher@example.com' }))
    const completing = completeAntigravityLogin(url)
    disconnectAntigravity()
    resolve(json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }))
    await expect(completing).rejects.toThrow('已取消')
    expect(getAntigravityStatus().connected).toBe(false)
  })

  it('reports revoked authorization without exposing the upstream error body', async () => {
    const { url } = await callback()
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant', error_description: 'private-information' }, 400))
    await expect(completeAntigravityLogin(url)).rejects.toThrow('Google 授权已失效，请重新登录')
    expect(getAntigravityStatus().connected).toBe(false)
  })
})
