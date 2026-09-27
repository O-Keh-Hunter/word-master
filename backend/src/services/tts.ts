/**
 * TTS（语音合成）抽象工厂
 *
 * 根据 TTS_PROVIDER 环境变量选择服务商：
 * - local（默认）：本地 Kokoro-82M
 * - xunfei：讯飞在线语音合成 v2
 */

import { synthesize as xunfeiSynthesize } from './xunfei/tts'
import { synthesizeLocal } from './local-speech'

export interface SpeechAudio { data: Buffer; contentType: 'audio/wav' | 'audio/mpeg' }

/**
 * 返回音频及其真实格式；浏览器同时支持 WAV 和 MP3。
 */
export async function synthesize(text: string, vcn?: string): Promise<SpeechAudio> {
  if (process.env.TTS_PROVIDER?.toLowerCase() === 'xunfei') {
    return { data: await xunfeiSynthesize(text, vcn), contentType: 'audio/mpeg' }
  }
  return { data: await synthesizeLocal(text, vcn), contentType: 'audio/wav' }
}
