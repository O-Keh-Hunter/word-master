import http from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSttStream } from './stt'

let server: http.Server
let wss: WebSocketServer
let port: number
const fetchMock = vi.fn<typeof fetch>()

beforeEach(async () => {
  vi.stubEnv('STT_PROVIDER', 'local')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  server = http.createServer()
  wss = new WebSocketServer({ server })
  wss.on('connection', handleSttStream)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterEach(async () => {
  for (const client of wss.clients) client.terminate()
  await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())))
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

async function record(chunks: Buffer[], command = 'done'): Promise<Record<string, unknown>> {
  const client = new WebSocket(`ws://127.0.0.1:${port}/api/stt/stream?lang=en_us`)
  return new Promise((resolve, reject) => {
    client.on('error', reject)
    client.on('message', data => resolve(JSON.parse(data.toString())))
    client.on('open', () => {
      for (const chunk of chunks) client.send(chunk)
      client.send(command)
    })
  })
}

describe('local STT over the browser WebSocket protocol', () => {
  it('accepts PCM followed immediately by done without dropping audio', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ text: 'look forward to' })))
    expect(await record([Buffer.from([1, 2]), Buffer.from([3, 4])])).toEqual({ text: 'look forward to' })
    expect(Array.from(fetchMock.mock.calls[0][1]!.body as Uint8Array)).toEqual([1, 2, 3, 4])
  })
  it('returns an empty answer for quick release', async () => {
    expect(await record([])).toEqual({ text: '' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('surfaces model service failure to the browser', async () => {
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }))
    expect((await record([Buffer.alloc(32)])).error).toContain('503')
  })
})
