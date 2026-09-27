import type { SttStreamSession } from './xunfei/stt'

const MAX_AUDIO_BYTES = 16000 * 2 * 30 // PCM16 mono, at most 30 seconds.
function serviceUrl(endpoint: string): string {
  return `${(process.env.LOCAL_SPEECH_URL || 'http://127.0.0.1:8001').replace(/\/$/, '')}/${endpoint}`
}

export function createLocalSttSession(
  lang: 'zh_cn' | 'en_us',
  onResult: (text: string) => void,
  onError: (message: string) => void,
): SttStreamSession {
  let chunks: Buffer[] = []
  let size = 0
  let ended = false
  let closed = false
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => { chunks = []; if (timer) clearTimeout(timer) }
  const fail = (message: string) => {
    if (closed) return
    closed = true
    controller.abort()
    clear()
    onError(message)
  }
  const recordingTimer = setTimeout(() => fail('录音超过 30 秒，请分段作答'), 35_000)
  recordingTimer.unref()
  return {
    sendAudio(chunk) {
      if (ended || closed) return
      size += chunk.length
      if (size > MAX_AUDIO_BYTES) { clearTimeout(recordingTimer); fail('录音超过 30 秒，请分段作答'); return }
      chunks.push(chunk)
    },
    end() {
      if (ended || closed) return
      ended = true
      clearTimeout(recordingTimer)
      if (size === 0) { closed = true; clear(); onResult(''); return }
      if (size % 2 !== 0) { fail('录音格式不正确，请重新录音'); return }
      const audio = Buffer.concat(chunks)
      chunks = []
      timer = setTimeout(() => fail('本地语音识别超时，请稍后重试'), 60_000)
      void (async () => {
        try {
          const response = await fetch(serviceUrl(`stt?lang=${lang}`), {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
            body: new Uint8Array(audio), signal: controller.signal,
          })
          if (!response.ok) throw new Error(`本地语音识别失败（${response.status}），请检查 speech 服务`)
          const data = await response.json() as { text?: unknown }
          if (typeof data.text !== 'string') throw new Error('本地语音识别返回格式不正确')
          if (closed) return
          closed = true
          clear()
          onResult(data.text.trim())
        } catch (error) {
          fail(error instanceof TypeError ? '无法连接本地语音服务，请启动 speech 服务' : (error as Error).message)
        }
      })()
    },
    close() {
      closed = true
      clearTimeout(recordingTimer)
      controller.abort()
      clear()
    },
  }
}

export async function synthesizeLocal(text: string, vcn?: string): Promise<Buffer> {
  // Existing Chinese voice hints remain compatible. Automatic detection also
  // handles Chinese text from callers that never supplied a voice hint.
  const lang = vcn === 'xiaoyan' || /[\u3400-\u9fff]/.test(text) ? 'zh_cn' : 'en_us'
  let response: Response
  try {
    response = await fetch(serviceUrl('tts'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang }), signal: AbortSignal.timeout(60_000),
    })
  } catch { throw new Error('本地朗读服务不可用或超时，请检查 speech 服务') }
  if (!response.ok) throw new Error(`本地朗读失败（${response.status}），请检查 speech 服务`)
  const audio = Buffer.from(await response.arrayBuffer())
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('本地朗读返回的音频格式不正确')
  }
  return audio
}
