import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeSuper } from './super-tts'

const sockets = vi.hoisted(() => [] as Array<import('events').EventEmitter & {
  send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>; readyState: number
}>)
vi.mock('./auth', () => ({ buildWsAuthUrl: () => 'wss://example.test/tts' }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('events')
  return { default: class extends EventEmitter {
    static CONNECTING = 0
    readyState = 1
    send = vi.fn()
    close = vi.fn()
    terminate = vi.fn()
    constructor() { super(); sockets.push(this) }
  } }
})
beforeEach(() => { sockets.length = 0; vi.useFakeTimers() })
afterEach(() => vi.useRealTimers())
function reply(body: unknown) { sockets[0].emit('message', Buffer.from(JSON.stringify(body))) }

describe('Xunfei super synthesis protocol', () => {
  it('preserves the text and concatenates audio frames through completion', async () => {
    const result = synthesizeSuper('苹果。')
    sockets[0].emit('open')
    const request = JSON.parse(sockets[0].send.mock.calls[0][0])
    expect(request.parameter.tts.vcn).toBe('x6_lingxiaoxuan_pro')
    expect(request.parameter.tts.audio).toMatchObject({ encoding: 'lame', sample_rate: 24000 })
    expect(request.parameter.oral).toMatchObject({ spark_assist: 0, remain: 1 })
    expect(Buffer.from(request.payload.text.text, 'base64').toString()).toBe('苹果。')
    reply({ header: { code: 0, status: 1 }, payload: { audio: { audio: Buffer.from('first').toString('base64'), status: 1 } } })
    reply({ header: { code: 0, status: 2 }, payload: { audio: { audio: Buffer.from('last').toString('base64'), status: 2 } } })
    expect((await result).toString()).toBe('firstlast')
    expect(sockets[0].close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('uses an explicitly selected English voice', async () => {
    const result = synthesizeSuper('apple', 'x5_EnUs_Lila_flow')
    sockets[0].emit('open')
    expect(JSON.parse(sockets[0].send.mock.calls[0][0]).parameter.tts.vcn).toBe('x5_EnUs_Lila_flow')
    reply({ header: { code: 0 }, payload: { audio: { audio: 'bXAz', status: 2 } } })
    expect((await result).toString()).toBe('mp3')
  })
  it('reports missing authorization without returning upstream private details', async () => {
    const result = synthesizeSuper('apple')
    reply({ header: { code: 11200, message: 'private upstream content' } })
    await expect(result).rejects.toThrow('发音人权限（11200）')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects a premature close even after partial audio', async () => {
    const result = synthesizeSuper('apple')
    reply({ header: { code: 0 }, payload: { audio: { audio: 'bXAz', status: 1 } } })
    sockets[0].emit('close')
    await expect(result).rejects.toThrow('提前关闭')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('times out and terminates a connection that never opens', async () => {
    const result = synthesizeSuper('apple')
    const failure = expect(result).rejects.toThrow('超时')
    sockets[0].readyState = 0
    await vi.advanceTimersByTimeAsync(45_000)
    await failure
    expect(sockets[0].terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['malformed', 'empty', 'network'])('rejects %s responses', async kind => {
    const result = synthesizeSuper('apple')
    if (kind === 'malformed') sockets[0].emit('message', Buffer.from('{'))
    if (kind === 'empty') reply({ header: { code: 0, status: 2 } })
    if (kind === 'network') sockets[0].emit('error', new Error('wss://private-url'))
    await expect(result).rejects.toThrow(/响应格式错误|未返回音频|连接失败/)
    expect(vi.getTimerCount()).toBe(0)
  })
})
