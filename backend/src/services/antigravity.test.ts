import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateExample, verifyChineseSemanticMatch } from './antigravity'

vi.mock('./antigravity-auth', () => ({
  ANTIGRAVITY_ENDPOINT: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
  ANTIGRAVITY_USER_AGENT: 'antigravity/test',
  getAntigravityCredentials: vi.fn(async () => ({ accessToken: 'access', projectId: 'own-project' })),
}))
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function reply(value: unknown, finishReason = 'STOP') {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ response: { candidates: [{
    finishReason, content: { parts: [{ thought: true, text: 'private reasoning' }, { text: JSON.stringify(value) }] },
  }] } })))
}

describe('Antigravity AI service', () => {
  it('uses the OAuth bearer, account project and configured model; ignores thought parts', async () => {
    vi.stubEnv('ANTIGRAVITY_MODEL', 'gemini-3-pro')
    reply({ example_en: ' I [read] at home. ', example_zh: ' 我在家[阅读]。 ' })
    expect(await generateExample('read', '阅读')).toEqual({ example_en: 'I [read] at home.', example_zh: '我在家[阅读]。' })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent')
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer access' })
    const body = JSON.parse(options?.body as string)
    expect(body).toMatchObject({ project: 'own-project', model: 'gemini-3-pro', userAgent: 'antigravity' })
    expect(body.request.contents[0].parts[0].text).toContain('read')
  })
  it('preserves a false semantic verdict', async () => {
    reply({ match: false, reason: '不同义' })
    expect(await verifyChineseSemanticMatch('美丽', '丑陋')).toEqual({ match: false, reason: '不同义' })
  })
  it.each([null, {}, { example_en: 123, example_zh: '例句' }, { example_en: ' ', example_zh: '例句' }])
    ('rejects invalid example data: %j', async value => {
      reply(value)
      await expect(generateExample('read', '阅读')).rejects.toThrow('格式不正确')
    })
  it('rejects string booleans from the model', async () => {
    reply({ match: 'false' })
    await expect(verifyChineseSemanticMatch('美丽', '丑陋')).rejects.toThrow('格式不正确')
  })
  it('rejects truncated responses even if the partial JSON parses', async () => {
    reply({ match: true }, 'MAX_TOKENS')
    await expect(verifyChineseSemanticMatch('美丽', '好看')).rejects.toThrow('未完成')
  })
  it('handles rate limits without leaking provider response data', async () => {
    fetchMock.mockResolvedValueOnce(new Response('sensitive provider payload', { status: 429 }))
    await expect(generateExample('read', '阅读')).rejects.toThrow('Antigravity 配额不足或请求过多，请稍后重试')
  })
})
