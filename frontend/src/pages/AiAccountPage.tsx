import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

interface AccountStatus { connected: boolean; email: string | null; model: string; connectionId: string | null }
interface Login { url: string; automaticCallback: boolean; expiresAt: number }

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

  useEffect(() => {
    void run(refresh)
  }, [])

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
        <div className="bg-white border rounded-2xl p-4 space-y-3">
          <p className="font-semibold text-gray-800">
            状态：<span className={status.connected ? 'text-green-600 font-bold' : 'text-gray-500'}>
              {status.connected ? '已连接 Google 账号' : '尚未连接'}
            </span>
          </p>
          {status.email && (
            <p className="text-sm text-gray-700">
              邮箱：<span className="font-mono font-medium text-gray-900">{status.email}</span>
            </p>
          )}
          <p className="text-sm text-gray-600">
            模型：<span className="font-mono text-gray-800">{status.model}</span>
          </p>
          <div className="pt-2 flex gap-3">
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
          <p className="text-xs text-gray-400">断开仅删除本服务保存的授权。也可前往 Google 账号的第三方连接管理撤销授权。</p>
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
