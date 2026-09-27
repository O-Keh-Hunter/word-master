import WebSocket from 'ws'
import { buildWsAuthUrl } from './auth'

// 讯飞流式听写：
// 默认采用标准版 iat-api.xfyun.cn/v2/iat（所有已注册 AppID 默认开通每日免费额度）
// 若显式设置 XUNFEI_STT_DOMAIN=slm，则走大模型版 iat.xf-yun.com/v1（需单独付费开通星火听写包）

type SttLanguage = 'zh_cn' | 'en_us'

export interface SttStreamSession {
  /** 发送 PCM 音频块（Int16, 16kHz, mono） */
  sendAudio(chunk: Buffer): void
  /** 告知音频已结束，等待最终识别结果 */
  end(): void
  /** 异常终止当前会话 */
  close(): void
}

export interface IatResultText {
  sn: number
  pgs?: 'apd' | 'rpl'
  rg?: [number, number]
  ws: Array<{ bg: number; cw: Array<{ w: string }> }>
  ls?: boolean
}

export function mergeResult(buf: Map<number, string>, result: IatResultText): Map<number, string> {
  const text = result.ws.map(w => w.cw[0]?.w ?? '').join('')
  const updated = new Map(buf)
  if (!result.pgs || result.pgs === 'apd') {
    updated.set(result.sn, text)
  } else if (result.pgs === 'rpl' && result.rg) {
    for (let i = result.rg[0]; i <= result.rg[1]; i++) updated.delete(i)
    updated.set(result.sn, text)
  }
  return updated
}

/**
 * 创建讯飞流式识别会话
 *
 * @param lang      识别语言
 * @param onResult  收到最终识别文本时回调
 * @param onError   发生错误时回调
 */
export function createXunfeiSttSession(
  lang: SttLanguage,
  onResult: (text: string) => void,
  onError: (msg: string) => void,
): SttStreamSession {
  const APP_ID = process.env.XUNFEI_APP_ID!
  const isV1 = process.env.XUNFEI_STT_DOMAIN === 'slm'
  const host = isV1 ? 'iat.xf-yun.com' : (process.env.XUNFEI_STT_HOST || 'iat-api.xfyun.cn')
  const path = isV1 ? '/v1' : (process.env.XUNFEI_STT_PATH || '/v2/iat')
  const iatWs = new WebSocket(buildWsAuthUrl(host, path))

  let resultBuf = new Map<number, string>()
  let seq = 0
  let firstSent = false
  let finished = false
  const pending: Buffer[] = []

  const terminateIat = () => {
    try { iatWs.terminate() } catch { /* ignore */ }
  }

  const sendChunk = (chunk: Buffer) => {
    if (iatWs.readyState !== WebSocket.OPEN) { pending.push(chunk); return }
    seq++
    let msg: unknown
    if (isV1) {
      msg = firstSent
        ? {
            header: { app_id: APP_ID, status: 1 },
            payload: { audio: { encoding: 'raw', sample_rate: 16000, channels: 1, bit_depth: 16, seq, status: 1, audio: chunk.toString('base64') } },
          }
        : {
            header: { app_id: APP_ID, status: 0 },
            parameter: {
              iat: {
                domain: 'slm', language: 'zh_cn', accent: 'mandarin',
                eos: 5000, dwa: 'wpgs', ptt: 0,
                ...(lang === 'en_us' ? { ltc: 3 } : {}),
                result: { encoding: 'utf8', compress: 'raw', format: 'json' },
              },
            },
            payload: { audio: { encoding: 'raw', sample_rate: 16000, channels: 1, bit_depth: 16, seq, status: 0, audio: chunk.toString('base64') } },
          }
    } else {
      msg = firstSent
        ? {
            data: { status: 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio: chunk.toString('base64') },
          }
        : {
            common: { app_id: APP_ID },
            business: {
              language: lang === 'en_us' ? 'en_us' : 'zh_cn',
              domain: 'iat',
              accent: 'mandarin',
              vad_eos: 5000,
              dwa: 'wpgs',
              ptt: 0,
            },
            data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: chunk.toString('base64') },
          }
    }
    firstSent = true
    iatWs.send(JSON.stringify(msg))
  }

  iatWs.on('open', () => {
    for (const chunk of pending) sendChunk(chunk)
    pending.length = 0
  })

  iatWs.on('message', (raw: WebSocket.RawData) => {
    interface V1Msg {
      header?: { code: number; message: string; status: number }
      payload?: { result?: { text: string } }
    }
    interface V2Msg {
      code?: number
      message?: string
      desc?: string
      data?: { result?: IatResultText; status?: number }
    }
    const msg = JSON.parse(raw.toString()) as V1Msg & V2Msg
    const code = msg.header?.code ?? msg.code ?? 0
    const errText = msg.header?.message ?? msg.message ?? msg.desc ?? '未知错误'
    const status = msg.header?.status ?? msg.data?.status ?? 0

    if (code !== 0) {
      finished = true
      onError(`识别服务错误 ${code}: ${errText}`)
      terminateIat()
      return
    }

    if (msg.data?.result) {
      resultBuf = mergeResult(resultBuf, msg.data.result)
    } else if (msg.payload?.result?.text) {
      try {
        const decoded = Buffer.from(msg.payload.result.text, 'base64').toString('utf8')
        resultBuf = mergeResult(resultBuf, JSON.parse(decoded) as IatResultText)
      } catch { /* ignore */ }
    }

    if (status === 2) {
      finished = true
      const text = [...resultBuf.entries()].sort(([a], [b]) => a - b).map(([, v]) => v).join('')
      onResult(text)
    }
  })

  iatWs.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).message?.includes('closed before the connection was established')) return
    if (!finished) { finished = true; onError('识别服务连接异常') }
  })

  return {
    sendAudio(chunk: Buffer) {
      if (!finished) sendChunk(chunk)
    },
    end() {
      if (finished) return
      if (!firstSent) {
        finished = true
        onResult('')
        terminateIat()
        return
      }
      seq++
      const endMsg = isV1
        ? {
            header: { app_id: APP_ID, status: 2 },
            payload: { audio: { encoding: 'raw', sample_rate: 16000, channels: 1, bit_depth: 16, seq, status: 2, audio: '' } },
          }
        : {
            data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' },
          }
      iatWs.send(JSON.stringify(endMsg))
    },
    close() {
      if (!finished) { finished = true; terminateIat() }
    },
  }
}
