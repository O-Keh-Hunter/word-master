export type NeuralTtsProvider = 'qwen3' | 'cosyvoice3'

/** Both model workers implement POST /tts -> PCM16 WAV. Models may run on a LAN GPU host. */
export async function synthesizeNeural(provider: NeuralTtsProvider, text: string, vcn?: string): Promise<Buffer> {
  const prefix = provider === 'qwen3' ? 'QWEN3_TTS' : 'COSYVOICE3_TTS'
  const label = provider === 'qwen3' ? 'Qwen3-TTS' : 'CosyVoice 3'
  const url = (process.env[`${prefix}_URL`] || `http://127.0.0.1:${provider === 'qwen3' ? 8002 : 8003}`).replace(/\/+$/, '')
  const seconds = Number(process.env.NEURAL_TTS_TIMEOUT_SECONDS || 180)
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
    throw new Error('NEURAL_TTS_TIMEOUT_SECONDS 必须在 1–600 秒之间')
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = process.env[`${prefix}_API_KEY`]
  if (key) headers.Authorization = `Bearer ${key}`
  let audio: Buffer
  try {
    const response = await fetch(`${url}/tts`, {
      method: 'POST', headers,
      body: JSON.stringify({ text, lang: vcn === 'xiaoyan' || /[\u3400-\u9fff]/.test(text) ? 'zh_cn' : 'en_us' }),
      signal: AbortSignal.timeout(seconds * 1000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`${label} 朗读失败（${response.status}），请检查模型服务、配置与授权`)
    }
    if (!response.body) throw new Error(`${label} 未返回音频`)
    const chunks: Buffer[] = []
    let size = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > 32 * 1024 * 1024) {
          await reader.cancel()
          throw new Error(`${label} 返回的音频过大`)
        }
        chunks.push(Buffer.from(value))
      }
    } finally { reader.releaseLock() }
    audio = Buffer.concat(chunks)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error
    throw new Error(`${label} 服务不可用或超时，请检查模型是否已加载及服务地址`)
  }
  if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${label} 返回的 WAV 音频格式不正确`)
  }
  return audio
}
