import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeNeural } from './neural-tts'

const fetchMock = vi.fn<typeof fetch>()
const wav = Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(100)])
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  for (const prefix of ['QWEN3_TTS', 'COSYVOICE3_TTS']) {
    vi.stubEnv(`${prefix}_URL`, '')
    vi.stubEnv(`${prefix}_API_KEY`, '')
  }
  vi.stubEnv('NEURAL_TTS_TIMEOUT_SECONDS', '180')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('neural TTS workers', () => {
  it.each(['qwen3', 'cosyvoice3'] as const)('calls the configured %s worker with language and private authorization', async provider => {
    const prefix = provider === 'qwen3' ? 'QWEN3_TTS' : 'COSYVOICE3_TTS'
    vi.stubEnv(`${prefix}_URL`, 'http://gpu-host:8002/')
    vi.stubEnv(`${prefix}_API_KEY`, 'worker-secret')
    fetchMock.mockResolvedValueOnce(new Response(wav))
    expect(await synthesizeNeural(provider, '你好')).toEqual(wav)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://gpu-host:8002/tts')
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer worker-secret' })
    expect(JSON.parse(options!.body as string)).toEqual({ text: '你好', lang: 'zh_cn' })
  })
  it.each([
    ['qwen3', 'apple', undefined, 8002, 'en_us'],
    ['cosyvoice3', 'Hello 你好', undefined, 8003, 'zh_cn'],
    ['qwen3', '123', 'xiaoyan', 8002, 'zh_cn'],
  ] as const)('maps %s text %s to the correct language', async (provider, text, voice, port, lang) => {
    fetchMock.mockResolvedValueOnce(new Response(wav))
    await synthesizeNeural(provider, text, voice)
    expect(fetchMock.mock.calls[0][0]).toBe(`http://127.0.0.1:${port}/tts`)
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).lang).toBe(lang)
  })
  it.each([401, 503, 500])('reports HTTP %i without leaking worker response content', async status => {
    fetchMock.mockResolvedValueOnce(new Response('private worker details', { status }))
    await expect(synthesizeNeural('qwen3', 'apple')).rejects.toThrow(`（${status}）`)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('rejects invalid WAV and empty output', async () => {
    fetchMock.mockResolvedValueOnce(new Response('RIFF0000WAVE'))
    await expect(synthesizeNeural('cosyvoice3', 'apple')).rejects.toThrow('WAV')
    fetchMock.mockResolvedValueOnce(new Response('error page'.repeat(20)))
    await expect(synthesizeNeural('qwen3', 'apple')).rejects.toThrow('WAV')
    fetchMock.mockResolvedValueOnce(new Response(null))
    await expect(synthesizeNeural('qwen3', 'apple')).rejects.toThrow('未返回音频')
  })
  it('bounds the response size while streaming', async () => {
    const cancel = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)) }, cancel,
    })))
    await expect(synthesizeNeural('qwen3', 'apple')).rejects.toThrow('音频过大')
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('uses a configured deadline and hides connection details', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubEnv('NEURAL_TTS_TIMEOUT_SECONDS', '60')
    fetchMock.mockRejectedValueOnce(new Error('secret-url-or-key'))
    await expect(synthesizeNeural('qwen3', 'apple')).rejects.toThrow('服务不可用或超时')
    expect(timeout).toHaveBeenCalledWith(60_000)
  })
  it.each(['0', '601', 'oops'])('rejects invalid deadline %s before sending', async value => {
    vi.stubEnv('NEURAL_TTS_TIMEOUT_SECONDS', value)
    await expect(synthesizeNeural('qwen3', 'apple')).rejects.toThrow('1–600')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
