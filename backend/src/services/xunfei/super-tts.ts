import WebSocket from 'ws'
import { buildWsAuthUrl } from './auth'

/** 超拟人合成；发音人需要单独授权，不改写学习文本。 */
export function synthesizeSuper(text: string, voice = 'x6_lingxiaoxuan_pro'): Promise<Buffer> {
  const url = buildWsAuthUrl('cbm01.cn-huabei-1.xf-yun.com', '/v1/private/mcd9m97e6')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 15_000 })
    const chunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => finish(new Error('讯飞超拟人合成超时')), 45_000)
    function finish(error?: Error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
      else ws.close()
      if (error) reject(error)
      else if (!chunks.length) reject(new Error('讯飞超拟人未返回音频'))
      else resolve(Buffer.concat(chunks))
    }
    ws.on('open', () => ws.send(JSON.stringify({
      header: { app_id: process.env.XUNFEI_APP_ID, status: 2 },
      parameter: {
        oral: { oral_level: 'low', spark_assist: 0, remain: 1 },
        tts: {
          vcn: voice, speed: 50, volume: 50, pitch: 50,
          bgs: 0, reg: 0, rdn: 0, rhy: 0,
          audio: { encoding: 'lame', sample_rate: 24000, channels: 1, bit_depth: 16, frame_size: 0 },
        },
      },
      payload: { text: {
        encoding: 'utf8', compress: 'raw', format: 'plain', status: 2, seq: 0,
        text: Buffer.from(text).toString('base64'),
      } },
    })))
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          header?: { code?: number; status?: number }
          code?: number
          payload?: { audio?: { audio?: string; status?: number } }
        }
        const code = message.header?.code ?? message.code
        if (code !== 0) {
          finish(new Error(code === 11200
            ? '讯飞超拟人未授权，请检查服务额度和所选发音人权限（11200）'
            : `讯飞超拟人合成失败（${code ?? '无效响应'}）`))
          return
        }
        const audio = message.payload?.audio
        if (audio?.audio) chunks.push(Buffer.from(audio.audio, 'base64'))
        if (message.header?.status === 2 || audio?.status === 2) finish()
      } catch { finish(new Error('讯飞超拟人响应格式错误')) }
    })
    ws.on('error', () => finish(new Error('讯飞超拟人连接失败，请检查网络与凭据')))
    ws.on('close', () => {
      if (!settled) finish(new Error('讯飞超拟人连接提前关闭，请重试'))
    })
  })
}
