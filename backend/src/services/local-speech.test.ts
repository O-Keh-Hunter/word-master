import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalSttSession, synthesizeLocal } from './local-speech'

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const result = (text = 'apple') => new Response(JSON.stringify({ text }))

describe('local recording adapter', () => {
  it('buffers PCM until done, sends once, and returns the final text', async () => {
    const onResult = vi.fn(), onError = vi.fn()
    const session = createLocalSttSession('en_us', onResult, onError)
    session.sendAudio(Buffer.from([1, 2])); session.sendAudio(Buffer.from([3, 4]))
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(result())
    session.end(); session.end(); session.sendAudio(Buffer.from([5, 6]))
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8001/stt?lang=en_us')
    expect(Array.from(options!.body as Uint8Array)).toEqual([1, 2, 3, 4])
    expect(onResult).toHaveBeenCalledWith('apple')
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not send empty recordings to the model', () => {
    const onResult = vi.fn()
    createLocalSttSession('zh_cn', onResult, vi.fn()).end()
    expect(onResult).toHaveBeenCalledWith('')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('aborts in-flight recognition on disconnect and suppresses late results', async () => {
    const onResult = vi.fn(), onError = vi.fn()
    let complete!: (value: Response) => void
    fetchMock.mockReturnValue(new Promise(resolve => { complete = resolve }))
    const session = createLocalSttSession('zh_cn', onResult, onError)
    session.sendAudio(Buffer.alloc(32)); session.end(); session.close()
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    complete(result('late'))
    await vi.advanceTimersByTimeAsync(1)
    expect(onResult).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
  it('limits recording size before allocating a combined audio buffer', () => {
    const onError = vi.fn()
    const session = createLocalSttSession('zh_cn', vi.fn(), onError)
    session.sendAudio(Buffer.alloc(960002)); session.end()
    expect(onError).toHaveBeenCalledWith('录音超过 30 秒，请分段作答')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('times out and reports only once', async () => {
    const onError = vi.fn()
    fetchMock.mockReturnValue(new Promise(() => {}))
    const session = createLocalSttSession('zh_cn', vi.fn(), onError)
    session.sendAudio(Buffer.alloc(32)); session.end()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onError).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it('reports unavailable service without switching to a cloud provider', async () => {
    const onError = vi.fn()
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const session = createLocalSttSession('zh_cn', vi.fn(), onError)
    session.sendAudio(Buffer.alloc(32)); session.end()
    await vi.advanceTimersByTimeAsync(1)
    expect(onError).toHaveBeenCalledWith('无法连接本地语音服务，请启动 speech 服务')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('local synthesis adapter', () => {
  it('selects Chinese and accepts a WAV response from the configured LAN service', async () => {
    vi.stubEnv('LOCAL_SPEECH_URL', 'http://speech:8001/')
    const wav = Buffer.from('RIFF0000WAVEtest')
    fetchMock.mockResolvedValue(new Response(wav))
    expect(await synthesizeLocal('你好')).toEqual(wav)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://speech:8001/tts')
    expect(JSON.parse(options!.body as string)).toEqual({ text: '你好', lang: 'zh_cn' })
  })
  it('rejects an invalid audio response', async () => {
    fetchMock.mockResolvedValue(new Response('not a WAV'))
    await expect(synthesizeLocal('apple')).rejects.toThrow('音频格式不正确')
  })
})
