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

  it('keeps the operator ask relevant after multiple tool-result rounds', () => {
    const spec = { ...MODELS.openai_strong, maxTools: 1 }
    const request = {
      ...params(
        [tool('generic_first'), tool('confirm_pending_action', 'Confirm a pending action for the operator')],
        'Confirm the pending action for the ODS quote'
      ),
      messages: [
        { role: 'user' as const, content: 'Confirm the pending action for the ODS quote' },
        {
          role: 'assistant' as const,
          content: [{ type: 'tool_use' as const, id: 'a', name: 'historical_lookup_a', input: {} }],
        },
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: 'a', content: 'calendar availability Tuesday' }],
        },
        {
          role: 'assistant' as const,
          content: [{ type: 'tool_use' as const, id: 'b', name: 'historical_lookup_b', input: {} }],
        },
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: 'b', content: 'revenue totals and booking counts' }],
        },
        {
          role: 'assistant' as const,
          content: [{ type: 'tool_use' as const, id: 'c', name: 'historical_lookup_c', input: {} }],
        },
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: 'c', content: 'customer phone and email details' }],
        },
      ],
    }

    const result = normalizeRequestForModel(spec, request as never)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.params.tools?.map((t) => t.name)).toEqual(['confirm_pending_action'])
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

  it('does not spend capacity on transcript tool names that are not in this request\'s surface', () => {
    // A back-office thread outlives any single tool surface: role/mode scoping
    // and registry churn mean the replayed transcript can name tools this turn
    // does not expose. Those names impose no capacity requirement — counting
    // them refuses a healthy provider for tools that were never being sent,
    // which is the exact failure this normalization exists to prevent.
    const spec = { ...MODELS.openai_strong, maxTools: 2 }
    const request = {
      ...params([tool('still_registered'), tool('other_a'), tool('other_b')]),
      messages: [
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use' as const, id: 'a', name: 'removed_in_a_later_deploy', input: {} },
            { type: 'tool_use' as const, id: 'b', name: 'not_exposed_to_this_role', input: {} },
            { type: 'tool_use' as const, id: 'c', name: 'still_registered', input: {} },
          ],
        },
      ],
    }
    const result = normalizeRequestForModel(spec, request as never)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.params.tools).toHaveLength(2)
    expect(result.value.params.tools?.map((t) => t.name)).toContain('still_registered')
  })

  it('selects the same surface every time for the same request, tools and model', () => {
    // Selection must be a pure function of the request. A surface that drifts
    // between identical calls would break prompt caching and make a bad
    // routing decision unreproducible from the logged attempt trail.
    const tools = Array.from({ length: 200 }, (_, i) =>
      tool(`tool_${i}`, i % 7 === 0 ? 'Handles unresolved customer issues for the business' : `Generic tool ${i}`)
    )
    const request = params(tools, 'Are there unresolved customer issues I should look at?')
    const signatures = new Set<string>()
    for (let run = 0; run < 20; run++) {
      const result = normalizeRequestForModel(MODELS.openai_strong, request as never)
      if (!result.ok) throw new Error('expected normalization to succeed')
      signatures.add(result.value.params.tools!.map((t) => t.name).join('|'))
    }

    expect(signatures.size).toBe(1)
  })

  it('preserves everything except the tool array, and keeps registry order', () => {
    const tools = Array.from({ length: 129 }, (_, i) => tool(`tool_${i}`))
    const request = {
      ...params(tools),
      system: 'SYSTEM PROMPT',
      temperature: 0.3,
      metadata: { user_id: 'operator-1' },
      stop_sequences: ['STOP'],
      tool_choice: { type: 'auto' as const },
    }
    const before = JSON.stringify(request)
    const result = normalizeRequestForModel(MODELS.openai_strong, request as never)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { tools: adapted, ...rest } = result.value.params
    const { tools: _original, ...originalRest } = request
    expect(rest).toEqual(originalRest)
    expect(result.value.params.messages).toBe(request.messages)
    // Order is the request's own order, not a relevance ranking.
    const keptIndexes = adapted!.map((t) => tools.findIndex((original) => original.name === t.name))
    expect(keptIndexes).toEqual([...keptIndexes].sort((a, b) => a - b))
    // And the canonical request is untouched.
    expect(JSON.stringify(request)).toBe(before)
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
