import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

interface AccountStatus {
  connected: boolean
  email: string | null
  model: string
  connectionId: string | null
  supportedModels?: string[]
}
interface Login { url: string; automaticCallback: boolean; expiresAt: number }

const MODEL_OPTIONS: { id: string; label: string; desc: string }[] = [
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash', desc: '官方默认 · 毫秒级响应，适合实时互动与背单词' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', desc: '强力推荐 · 语言自然地道，例句丰富贴切' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking', desc: '深度思考 · 逻辑推理全面，适合复杂判题' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: '备用模型 · 快速稳定' },
]

export default function AiAccountPage() {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [login, setLogin] = useState<Login | null>(null)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function api<T>(action: string, body?: object): Promise<T> {
    const response = await fetch(`/api/ai-auth/${action}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '请求失败，请重试')
    return data as T
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await action() }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  async function refresh() {
    const next = await api<AccountStatus>('status')
    setStatus(next)
    if (next.connected && next.connectionId !== status?.connectionId) { setLogin(null); setCallbackUrl('') }
  }

  async function handleModelChange(newModel: string) {
    await run(async () => {
      const next = await api<AccountStatus>('model', { model: newModel })
      setStatus(next)
    })
  }

  useEffect(() => {
    void run(refresh)
  }, [])

  const currentDesc = MODEL_OPTIONS.find(opt => opt.id === status?.model)?.desc

  return (
    <div className="p-4 pt-8 space-y-5">
      <Link to="/" className="text-sm text-primary-600">‹ 返回首页</Link>
      <div>
        <h1 className="text-2xl font-bold text-gray-800">AI 账号</h1>
        <p className="text-sm text-gray-500 mt-2">连接 Google 账号，为所有学生生成记忆例句、辅助语义判题。</p>
      </div>
      <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">
        Antigravity OAuth 为非官方接入，可能导致 Google 账号受限。请先在官方 Antigravity 中完成账号开通。
      </div>
      {error && <p role="alert" className="text-sm text-red-600 break-words">{error}</p>}
      {status ? (
        <div className="bg-white border rounded-2xl p-4 space-y-4">
          <div>
            <span className="text-xs text-gray-400 font-semibold tracking-wider uppercase">连接状态</span>
            <p className="text-base font-semibold text-gray-800 mt-0.5">
              <span className={status.connected ? 'text-green-600 font-bold' : 'text-gray-500'}>
                {status.connected ? '● 已连接 Google 账号' : '○ 尚未连接'}
              </span>
            </p>
          </div>
          {status.email && (
            <div>
              <span className="text-xs text-gray-400 font-semibold tracking-wider uppercase">授权邮箱</span>
              <p className="text-sm font-mono font-medium text-gray-800 mt-0.5 break-all">{status.email}</p>
            </div>
          )}
          <div className="space-y-1.5 pt-1 border-t border-gray-100">
            <label htmlFor="model-select" className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">
              AI 模型选择
            </label>
            <select
              id="model-select"
              value={status.model}
              disabled={busy}
              onChange={e => void handleModelChange(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-medium text-gray-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50"
            >
              {MODEL_OPTIONS.map(opt => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            {currentDesc && (
              <p className="text-xs text-primary-600 font-normal mt-1">{currentDesc}</p>
            )}
          </div>
          <div className="pt-2 flex gap-3 border-t border-gray-100">
            <button disabled={busy} onClick={() => void run(async () => {
              setLogin(await api<Login>('login', {})); setCallbackUrl('')
            })} className="flex-1 border border-primary-300 text-primary-700 rounded-xl py-2 text-sm disabled:opacity-50">
              {status.connected ? '更换 Google 账号' : '使用 Google 账号登录'}
            </button>
            {status.connected && (
              <button disabled={busy} onClick={() => void run(async () => {
                setStatus(await api<AccountStatus>('disconnect', {})); setLogin(null); setCallbackUrl('')
              })} className="px-4 text-sm text-red-600 border border-red-200 rounded-xl py-2 disabled:opacity-50">
                断开连接
              </button>
            )}
          </div>
          <button disabled={busy} onClick={() => void run(refresh)} className="w-full text-xs text-gray-400 py-1 hover:text-gray-600">
            {busy ? '正在刷新…' : '刷新连接状态'}
          </button>
        </div>
      ) : (
        <div className="bg-white border rounded-2xl p-6 text-center text-sm text-gray-400">
          正在加载 AI 账号状态…
        </div>
      )}
      {login && (
        <div className="bg-white border rounded-2xl p-4 space-y-4">
          <a href={login.url} target="_blank" rel="noopener noreferrer" className="block text-center rounded-xl bg-primary-600 text-white py-3">打开 Google 授权页面 ↗</a>
          <p className="text-sm text-gray-600">在新页面完成授权后，回到这里刷新连接状态。登录链接 10 分钟内有效。</p>
          <p className="text-sm text-gray-600">
            如果授权后跳转到 localhost 提示无法访问，请复制地址栏的完整链接，粘贴到下方完成连接。
          </p>
          <label htmlFor="ai-callback" className="block text-sm font-medium">授权后的回调链接</label>
          <textarea id="ai-callback" value={callbackUrl} onChange={e => setCallbackUrl(e.target.value)} rows={3}
            autoComplete="off" spellCheck={false} className="w-full border rounded-xl p-3 text-sm"
            placeholder="http://localhost:51121/oauth-callback?…" />
          <button disabled={busy || !callbackUrl.trim()} onClick={() => void run(async () => {
            setStatus(await api<AccountStatus>('complete', { callbackUrl: callbackUrl.trim() }))
            setLogin(null); setCallbackUrl('')
          })} className="w-full rounded-xl bg-primary-600 text-white py-2 disabled:opacity-50">完成连接</button>
        </div>
      )}
    </div>
  )
}
