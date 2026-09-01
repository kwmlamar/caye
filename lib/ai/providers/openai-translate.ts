import 'server-only'
import type { AIMessageParams, AIResponseMessage, AITool } from '../types'

/** Anthropic-schema <-> OpenAI Chat Completions translation. */
export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
}

export function systemText(system: AIMessageParams['system']): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system
    .map((block) => (typeof block === 'string' ? block : (block as { text?: string }).text ?? ''))
    .filter(Boolean)
    .join('\n\n')
}

function imagePart(block: Record<string, unknown>): Record<string, unknown> | null {
  const source = block.source as Record<string, unknown> | undefined
  if (!source) return null
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } }
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  return null
}

/**
 * Tool messages themselves are text-only in Chat Completions. Keep their text
 * in the tool message, then carry any nested images into the immediately
 * following user multimodal message. This preserves the observation instead
 * of silently replacing it with "image omitted" during provider failover.
 */
function translateToolResult(content: unknown): { text: string; images: Record<string, unknown>[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: JSON.stringify(content ?? ''), images: [] }

  const text: string[] = []
  const images: Record<string, unknown>[] = []
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (b?.type === 'text' && typeof b.text === 'string') {
      text.push(b.text)
    } else if (b?.type === 'image') {
      const image = imagePart(b)
      if (image) {
        images.push(image)
        text.push('[image supplied in the following user message]')
      }
    } else {
      text.push(JSON.stringify(b))
    }
  }
  return { text: text.join('\n'), images }
}

export function toOpenAiMessages(params: AIMessageParams): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  const system = systemText(params.system)
  if (system) out.push({ role: 'system', content: system })

  for (const message of params.messages ?? []) {
    const content = message.content
    if (typeof content === 'string') {
      out.push({ role: message.role, content })
      continue
    }
    if (!Array.isArray(content)) continue

    if (message.role === 'assistant') {
      const text: string[] = []
      const toolCalls: unknown[] = []
      for (const raw of content) {
        const block = raw as unknown as Record<string, unknown>
        if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
        if (block?.type === 'tool_use') {
          toolCalls.push({
            id: String(block.id ?? ''),
            type: 'function',
            function: { name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) },
          })
        }
      }
      out.push({ role: 'assistant', content: text.length ? text.join('\n') : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
      continue
    }

    // OpenAI requires tool results before any subsequent user content for the
    // same turn. Nested tool-result images therefore join that subsequent
    // user message after their matching role:'tool' messages.
    const userParts: unknown[] = []
    const toolMessages: OpenAiMessage[] = []
    for (const raw of content) {
      const block = raw as unknown as Record<string, unknown>
      if (block?.type === 'text' && typeof block.text === 'string') {
        userParts.push({ type: 'text', text: block.text })
      } else if (block?.type === 'image') {
        const part = imagePart(block)
        if (part) userParts.push(part)
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const translated = translateToolResult(block.content)
        toolMessages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: translated.text })
        userParts.push(...translated.images)
      }
    }
    out.push(...toolMessages)
    if (userParts.length) {
      const onlyText = userParts.every((p) => (p as { type?: string }).type === 'text')
      out.push({ role: 'user', content: onlyText ? userParts.map((p) => (p as { text: string }).text).join('\n') : userParts })
    }
  }
  return out
}

export function toOpenAiTools(tools: AIMessageParams['tools']): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .map((tool) => {
      const t = tool as AITool
      if (!t?.name) return null
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: stripAnthropicOnly(t.input_schema),
        },
      }
    })
    .filter(Boolean) as unknown[]
}

function stripAnthropicOnly(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }
  const { cache_control: _ignored, ...rest } = schema as Record<string, unknown>
  return rest
}

export function toOpenAiToolChoice(choice: AIMessageParams['tool_choice']): unknown {
  if (!choice) return undefined
  switch (choice.type) {
    case 'any': return 'required'
    case 'tool': return { type: 'function', function: { name: (choice as { name: string }).name } }
    case 'none': return 'none'
    default: return 'auto'
  }
}

const STOP_REASONS: Record<string, AIResponseMessage['stop_reason']> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

function safeArgs(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(typeof raw === 'string' && raw.trim() ? raw : '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function fromOpenAiResponse(json: Record<string, any>, fallbackModel: string): AIResponseMessage {
  const message = json?.choices?.[0]?.message ?? {}
  const calls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const content: any[] = []

  if (typeof message.content === 'string' && message.content.trim()) {
    content.push({ type: 'text', text: message.content, citations: null })
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text, citations: null })
    }
  }

  calls.forEach((call, index) => {
    content.push({
      type: 'tool_use',
      id: typeof call?.id === 'string' && call.id ? call.id : `call_${Date.now()}_${index}`,
      name: call?.function?.name ?? '',
      input: safeArgs(call?.function?.arguments),
    })
  })

  const rawFinish = json?.choices?.[0]?.finish_reason
  const usage = json?.usage ?? {}
  const cachedInput = usage?.prompt_tokens_details?.cached_tokens ?? 0

  return {
    id: json?.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: json?.model ?? fallbackModel,
    content,
    stop_reason: calls.length > 0 ? 'tool_use' : STOP_REASONS[rawFinish] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cachedInput),
      output_tokens: usage.completion_tokens ?? 0,
      cache_read_input_tokens: cachedInput,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as AIResponseMessage
}
