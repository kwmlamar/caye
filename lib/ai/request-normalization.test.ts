import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { normalizeRequestForModel } = await import('./request-normalization')
const { MODELS } = await import('./models')

type Tool = {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, unknown> }
}

function tool(name: string, description = ''): Tool {
  return { name, description, input_schema: { type: 'object', properties: {} } }
}

function params(tools: Tool[], content = 'give me a business update') {
  return {
    model: 'ignored',
    max_tokens: 100,
    messages: [{ role: 'user' as const, content }],
    tools,
  }
}

describe('normalizeRequestForModel', () => {
  it('leaves a request unchanged when the model can accept its full tool surface', () => {
    const request = params([tool('one')])
    const result = normalizeRequestForModel(MODELS.openai_strong, request as never)

    expect(result).toEqual({ ok: true, value: { params: request } })
  })

  it('adapts an oversized provider-neutral tool surface to the model cap', () => {
    const tools = Array.from({ length: 129 }, (_, i) => tool(`tool_${i}`))
    const request = params(tools)
    const result = normalizeRequestForModel(MODELS.openai_strong, request as never)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.params.tools).toHaveLength(128)
    expect(result.value.detail).toContain('129->128')
    expect(request.tools).toHaveLength(129)
  })

  it('uses request relevance to keep a needed tool instead of blindly truncating', () => {
    const spec = { ...MODELS.openai_strong, maxTools: 2 }
    const request = params(
      [tool('generic_first'), tool('generic_second'), tool('find_unresolved_customer_issues', 'Find unresolved customer issues')],
      'Are there any unresolved customer issues?'
    )
    const result = normalizeRequestForModel(spec, request as never)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.params.tools?.map((t) => t.name)).toContain('find_unresolved_customer_issues')
  })

  it('never prunes an explicitly forced tool', () => {
    const spec = { ...MODELS.openai_strong, maxTools: 1 }
    const request = {
      ...params([tool('first'), tool('must_run')]),
      tool_choice: { type: 'tool' as const, name: 'must_run' },
    }
    const result = normalizeRequestForModel(spec, request as never)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.params.tools?.map((t) => t.name)).toEqual(['must_run'])
  })

  it('never prunes a tool already referenced by the conversation transcript', () => {
    const spec = { ...MODELS.openai_strong, maxTools: 1 }
    const request = {
      ...params([tool('first'), tool('already_used')]),
      messages: [
        { role: 'user' as const, content: 'continue' },
        {
          role: 'assistant' as const,
          content: [{ type: 'tool_use' as const, id: 'tu_1', name: 'already_used', input: {} }],
        },
        { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'tu_1', content: 'ok' }] },
      ],
    }
    const result = normalizeRequestForModel(spec, request as never)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.params.tools?.map((t) => t.name)).toEqual(['already_used'])
  })

  it('fails closed when continuity requirements themselves exceed the provider cap', () => {
    const spec = { ...MODELS.openai_strong, maxTools: 1 }
    const request = {
      ...params([tool('one'), tool('two')]),
      messages: [
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use' as const, id: 'a', name: 'one', input: {} },
            { type: 'tool_use' as const, id: 'b', name: 'two', input: {} },
          ],
        },
      ],
    }
    const result = normalizeRequestForModel(spec, request as never)

    expect(result).toMatchObject({ ok: false, missing: 'tool_capacity' })
  })
})
