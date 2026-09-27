/**
 * STT（语音识别）抽象工厂
 *
 * 根据 STT_PROVIDER 环境变量选择服务商：
 * - local（默认）：本地 SenseVoice Small（松手后识别）
 * - xunfei：讯飞 Spark IAT
 * - tencent：腾讯云实时语音识别（16k_zh_en 中英混合引擎）
 */

import type { SttStreamSession } from './xunfei/stt'
import { createXunfeiSttSession } from './xunfei/stt'
import { createTencentSttSession } from './tencent/stt'
import { createLocalSttSession } from './local-speech'

type SttLanguage = 'zh_cn' | 'en_us'

/** 可用的 STT 服务商 */
export type SttProvider = 'local' | 'xunfei' | 'tencent'

/** 默认使用本地服务；云服务需显式配置。 */
function getSttProvider(): SttProvider {
  const p = process.env.STT_PROVIDER?.toLowerCase()
  if (p === 'tencent') return 'tencent'
  if (p === 'xunfei') return 'xunfei'
  return 'local'
}

/**
 * 创建一个流式语音识别会话。
 */
export function createSttSession(
  lang: SttLanguage,
  onResult: (text: string) => void,
  onError: (msg: string) => void,
): SttStreamSession {
  const provider = getSttProvider()
  if (provider === 'local') return createLocalSttSession(lang, onResult, onError)
  if (provider === 'tencent') {
    return createTencentSttSession(lang, onResult, onError)
  }
  return createXunfeiSttSession(lang, onResult, onError)
}
