import { createHash, randomBytes, randomUUID } from 'crypto'
import fs from 'fs'
import http from 'http'
import path from 'path'

// Protocol reference: https://github.com/NoeFabris/opencode-antigravity-auth
function oauthClient() {
  const client_id = process.env.ANTIGRAVITY_CLIENT_ID?.trim()
  const client_secret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim()
  if (!client_id || !client_secret) {
    throw new Error('请在服务端配置 ANTIGRAVITY_CLIENT_ID 和 ANTIGRAVITY_CLIENT_SECRET 后再登录')
  }
  return { client_id, client_secret }
}
export const REDIRECT_URI = 'http://localhost:51121/oauth-callback'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPES = ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs']
  .map(scope => `https://www.googleapis.com/auth/${scope}`)
export const ANTIGRAVITY_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
export const ANTIGRAVITY_USER_AGENT = `antigravity/1.18.3 ${process.platform}/${process.arch}`

export const SUPPORTED_MODELS = [
  'gemini-3-flash',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gemini-2.5-flash',
] as const

export type AntigravityModel = typeof SUPPORTED_MODELS[number]

interface Account {
  id: string
  email: string
  projectId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  model?: string
}
interface PendingLogin { verifier: string; expiresAt: number; generation: number }
const pending = new Map<string, PendingLogin>()
let generation = 0
let refreshing: Promise<Account> | undefined
let callbackServer: http.Server | undefined
let startingServer: Promise<boolean> | undefined
let cleanupTimer: ReturnType<typeof setTimeout> | undefined

function accountPath(): string {
  return process.env.ANTIGRAVITY_AUTH_FILE || path.join(process.cwd(), 'data', 'antigravity-account.json')
}

function readAccount(): Account | undefined {
  try {
    const account = JSON.parse(fs.readFileSync(accountPath(), 'utf8')) as Account
    if (!account.id || !account.accessToken || !account.refreshToken || !account.projectId ||
        !Number.isFinite(account.expiresAt)) throw new Error('invalid account')
    return account
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('AI 账号文件无法读取，请重新连接账号或检查文件权限')
  }
}

function saveAccount(account: Account): void {
  const file = accountPath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(account), { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function isAntigravityConnected(): boolean {
  try { return !!readAccount() } catch { return false }
}

let inMemoryModel: string | undefined

export function getSelectedModel(): string {
  const account = readAccount()
  return account?.model || inMemoryModel || process.env.ANTIGRAVITY_MODEL || 'gemini-3-flash'
}

export function setSelectedModel(model: string): void {
  if (!SUPPORTED_MODELS.includes(model as AntigravityModel)) {
    throw new Error(`不支持的模型: ${model}，支持的模型为: ${SUPPORTED_MODELS.join(', ')}`)
  }
  inMemoryModel = model
  const account = readAccount()
  if (account) {
    account.model = model
    saveAccount(account)
  }
}

export function getAntigravityStatus() {
  const account = readAccount()
  return {
    connected: !!account,
    email: account?.email ?? null,
    connectionId: account?.id ?? null,
    model: getSelectedModel(),
    supportedModels: [...SUPPORTED_MODELS],
  }
}

function closeCallbackServer() {
  callbackServer?.close()
  callbackServer = undefined
  if (cleanupTimer) clearTimeout(cleanupTimer)
  cleanupTimer = undefined
}

export function disconnectAntigravity(): void {
  generation++
  pending.clear()
  closeCallbackServer()
  fs.rmSync(accountPath(), { force: true })
}

async function tokenRequest(params: Record<string, string>) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...oauthClient(), ...params }),
    signal: AbortSignal.timeout(20_000),
  })
  const data = await response.json() as {
    access_token?: string; refresh_token?: string; expires_in?: number; error?: string
  }
  if (!response.ok) {
    if (data.error === 'invalid_grant') throw new Error('Google 授权已失效，请重新登录')
    throw new Error(`Google OAuth 请求失败（${response.status}），请重试`)
  }
  if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number' || data.expires_in <= 0) {
    throw new Error('Google 未返回有效的访问令牌')
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 }
}

async function discoverProject(accessToken: string): Promise<string> {
  // Only use the project assigned to this account; never borrow a fallback project.
  for (const endpoint of ['https://cloudcode-pa.googleapis.com', ANTIGRAVITY_ENDPOINT]) {
    const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': ANTIGRAVITY_USER_AGENT },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) continue
    const data = await response.json() as { cloudaicompanionProject?: string | { id?: string } }
    const project = typeof data.cloudaicompanionProject === 'string'
      ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id
    if (project) return project
  }
  throw new Error('未找到 Antigravity 项目，请先在官方 Antigravity 中登录并完成账号开通，再重新连接')
}

export async function completeAntigravityLogin(callbackUrl: string): Promise<void> {
  let url: URL
  try { url = new URL(callbackUrl) } catch { throw new Error('请粘贴完整的授权回调链接') }
  const expected = new URL(REDIRECT_URI)
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new Error('授权回调地址不正确')
  const state = url.searchParams.get('state') || ''
  const login = pending.get(state)
  if (!login || login.expiresAt < Date.now()) {
    pending.delete(state)
    throw new Error('登录请求已过期或不匹配，请重新发起登录')
  }
  pending.delete(state) // One-time state, including denied/failed exchanges.
  if (url.searchParams.has('error')) throw new Error('Google 授权已取消，请重新登录')
  const code = url.searchParams.get('code')
  if (!code) throw new Error('授权回调中缺少 code，请重新登录')
  const token = await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: login.verifier,
  })
  if (!token.refreshToken) throw new Error('Google 未返回刷新令牌，请重新授权')
  const projectId = await discoverProject(token.accessToken)
  const userResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
    headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(15_000),
  })
  if (!userResponse.ok) throw new Error('无法读取 Google 账号信息，请重新登录')
  const user = await userResponse.json() as { email?: string }
  if (typeof user.email !== 'string' || !user.email) throw new Error('Google 未返回账号邮箱')
  // Disconnecting or beginning a newer login invalidates any in-flight exchange.
  if (generation !== login.generation) throw new Error('登录请求已取消，请重新登录')
  saveAccount({ id: randomUUID(), email: user.email, projectId, ...token, refreshToken: token.refreshToken })
  closeCallbackServer()
}

async function startCallbackServer(): Promise<boolean> {
  if (callbackServer?.listening) return true
  if (startingServer) return startingServer
  startingServer = new Promise<boolean>(resolve => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      const url = new URL(req.url || '/', REDIRECT_URI)
      if (req.method !== 'GET' || url.pathname !== '/oauth-callback') {
        res.writeHead(404).end('Not found')
        return
      }
      void completeAntigravityLogin(url.toString()).then(() => {
        res.end('Google 账号连接成功。请关闭此页面，返回 Word Master 刷新连接状态。')
      }).catch(() => {
        res.writeHead(400).end('授权未完成或已过期。请返回 Word Master 重新登录。')
      })
    })
    server.once('error', () => { server.close(); resolve(false) })
    // Loopback only. Remote/Docker users can submit the full callback URL in the UI.
    server.listen(51121, '127.0.0.1', () => {
      callbackServer = server
      server.unref()
      resolve(true)
    })
  })
  try { return await startingServer } finally { startingServer = undefined }
}

export async function beginAntigravityLogin() {
  const { client_id } = oauthClient()
  generation++
  pending.clear()
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + 10 * 60_000
  pending.set(state, { verifier, expiresAt, generation })
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({
    client_id, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'select_account consent', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString()
  const automaticCallback = await startCallbackServer()
  if (cleanupTimer) clearTimeout(cleanupTimer)
  cleanupTimer = setTimeout(() => { pending.clear(); closeCallbackServer() }, 10 * 60_000)
  cleanupTimer.unref()
  return { url: url.toString(), expiresAt, automaticCallback }
}

export async function getAntigravityCredentials(): Promise<Account> {
  const account = readAccount()
  if (!account) throw new Error('请先在 AI 账号页面连接 Google 账号')
  if (account.expiresAt > Date.now() + 60_000) return account
  if (!refreshing) {
    refreshing = (async () => {
      const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken })
      if (readAccount()?.id !== account.id) throw new Error('AI 账号已变更，请重试')
      const updated = { ...account, ...token, refreshToken: token.refreshToken || account.refreshToken }
      saveAccount(updated)
      return updated
    })().finally(() => { refreshing = undefined })
  }
  return refreshing
}
