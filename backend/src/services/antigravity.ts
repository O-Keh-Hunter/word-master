/**
 * Antigravity Gemini 例句生成服务
 * 生成符合方案C（情境记忆锚点）风格的例句：
 *  - 第一人称 / 初中生日常场景
 *  - 句子本身词汇不超过初中水平
 *  - 目标词加 [...] 标记
 *  - 英文不超过 12 词，中文不超过 15 字
 */

import { randomUUID } from 'crypto'
import { ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_USER_AGENT, getAntigravityCredentials } from './antigravity-auth'

async function generateJson(system: string, prompt: string): Promise<Record<string, unknown>> {
  const account = await getAntigravityCredentials()
  const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': ANTIGRAVITY_USER_AGENT,
    },
    body: JSON.stringify({
      project: account.projectId,
      model: process.env.ANTIGRAVITY_MODEL || 'gemini-3-flash',
      userAgent: 'antigravity', requestType: 'agent', requestId: `agent-${randomUUID()}`,
      request: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 },
      },
    }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) {
    // Never include upstream payloads: they may contain account or request data.
    if (response.status === 401) throw new Error('Google 授权失效，请重新连接 AI 账号')
    if (response.status === 403) throw new Error('Antigravity 账号无访问权限，请检查账号是否已开通')
    if (response.status === 429) throw new Error('Antigravity 配额不足或请求过多，请稍后重试')
    throw new Error(`Antigravity 请求失败（${response.status}）`)
  }
  interface Generation {
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[]
    promptFeedback?: { blockReason?: string }
  }
  const payload = await response.json() as Generation & { response?: Generation }
  const data = payload.response || payload
  const candidate = data.candidates?.[0]
  if (data.promptFeedback?.blockReason || (candidate?.finishReason && candidate.finishReason !== 'STOP')) {
    throw new Error('Antigravity 未完成生成，请重试')
  }
  const content = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('').trim()
  if (!content) throw new Error('Antigravity 返回内容为空')
  try {
    const parsed: unknown = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid object')
    return parsed as Record<string, unknown>
  } catch { throw new Error('Antigravity 返回格式不正确') }
}

const SYSTEM_PROMPT = `你是一个初中英语教学助手，负责为英语词汇/短语生成记忆例句。

例句风格要求（非常重要）：
1. 场景：必须是初中生日常生活场景，例如：写作业、打游戏、找东西、吃饭、看手机、和父母/朋友、考试、放假等
2. 人称：优先使用第一人称 "I / 我"，让学生产生代入感
3. 难度：句子本身的词汇不超过初中水平，绝对不能引入比目标词更难的生词
4. 高亮标记：在英文例句中，用方括号 [目标词] 包裹目标词或其变体形式
5. 长度：英文不超过 12 个单词，中文不超过 15 个字
6. 语气：自然口语化，不要教科书腔

好的例句风格（参考）：
- look for -> "I'm always [looking for] my phone before school." / "我上学前总是在[找]我的手机。"
- give up -> "Don't [give up] the game, you're so close!" / "别[放弃]这局游戏，你快赢了！"
- look forward to -> "I really [look forward to] the summer holiday." / "我超级期待放暑假。"

请严格按照 JSON 格式输出，不要有多余文字。`

interface ExampleResult {
  example_en: string
  example_zh: string
}

/**
 * 为单个词汇调用 Antigravity Gemini 生成方案C风格例句
 * @throws 网络错误或 API 返回非 200 时抛出
 */
export async function generateExample(english: string, chinese: string): Promise<ExampleResult> {
  const userPrompt = `词汇：${english}\n词义：${chinese}\n\n请生成一对例句，输出 JSON：\n{"example_en": "...", "example_zh": "..."}`

  const parsed = await generateJson(SYSTEM_PROMPT, userPrompt)
  if (typeof parsed.example_en !== 'string' || !parsed.example_en.trim() ||
      typeof parsed.example_zh !== 'string' || !parsed.example_zh.trim()) {
    throw new Error('Antigravity 返回的例句格式不正确')
  }

  return {
    example_en: parsed.example_en.trim(),
    example_zh: parsed.example_zh.trim(),
  }
}

/**
 * 中文语义等价验证（LLM 兜底）
 *
 * 当 MiniLM 向量相似度处于灰色地带（0.60–0.85）时，
 * 调用 Antigravity 做最终语义判定，弥补小模型对中文短语区分能力不足的问题。
 *
 * @returns match 是否语义等价，reason 简短理由
 */
export async function verifyChineseSemanticMatch(
  standard: string,
  answer: string,
): Promise<{ match: boolean; reason: string }> {
  const systemPrompt = `你是一个中文语义判定助手。你的任务是判断两个中文短语是否语义等价（同义/近义）。

判定规则：
1. 同义词/近义词 → 等价（如"美丽"和"好看"等价，"下决心"和"做决定"等价）
2. 包含关系 → 等价（如用户说"下定决心"对应标准"下决心"，包含关键词）
3. 语义完全不同 → 不等价（如"下决心"和"指导作用"不等价）
4. 反义词 → 不等价（如"美丽"和"丑陋"不等价）

请严格只输出 JSON，不要有任何其他文字。`

  const userPrompt = `标准答案：${standard}\n用户答案：${answer}\n\n请判断这两个中文短语是否语义等价，输出 JSON：\n{"match": true/false, "reason": "一句话理由"}`

  const parsed = await generateJson(systemPrompt, userPrompt)
  if (typeof parsed.match !== 'boolean' || (parsed.reason !== undefined && typeof parsed.reason !== 'string')) {
    throw new Error('Antigravity 返回的语义判断格式不正确')
  }

  return {
    match: parsed.match,
    reason: (parsed.reason as string | undefined) ?? (parsed.match ? '语义等价' : '语义不等价'),
  }
}
