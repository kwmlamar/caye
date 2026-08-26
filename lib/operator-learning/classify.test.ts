import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/llm-telemetry', () => ({
  loggedMessagesCreate: async (_client: unknown, params: { messages: { content: string }[] }) => responseFactory(params),
}))
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))

let responseFactory: (params: unknown) => { content: { type: string; text: string }[] }

const { classifyOperatorMessage } = await import('./classify')
const { prefilterOperatorMessage } = await import('./prefilter')

beforeEach(() => {
  responseFactory = () => ({ content: [{ type: 'text', text: '{}' }] })
})

const prefilter = prefilterOperatorMessage('We only use online payment.')

describe('classifyOperatorMessage', () => {
  it('parses a well-formed JSON response, including one wrapped in a markdown fence', async () => {
    responseFactory = () => ({
      content: [
        {
          type: 'text',
          text:
            '```json\n' +
            JSON.stringify({
              learnable: true,
              explicitness: 'explicit_correction',
              scope: { kind: 'standing', target: 'workspace' },
              risk: 'low',
              destination: 'business_fact',
              canonicalKey: 'payment-method',
              confidence: 0.9,
              rationale: 'x',
              businessFact: { category: 'policy', text: 'We only use online payment.' },
            }) +
            '\n```',
        },
      ],
    })
    const res = await classifyOperatorMessage({
      operatorText: 'We only use online payment.',
      prefilter,
      previousCayeText: null,
      workspaceId: 'ws-1',
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.destination).toBe('business_fact')
  })

  it('returns a typed error, never throws, on malformed JSON', async () => {
    responseFactory = () => ({ content: [{ type: 'text', text: 'not json at all {{{' }] })
    const res = await classifyOperatorMessage({
      operatorText: 'We only use online payment.',
      prefilter,
      previousCayeText: null,
      workspaceId: 'ws-1',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/not valid JSON/)
  })

  it('returns a typed error when the JSON is well-formed but fails schema validation', async () => {
    responseFactory = () => ({ content: [{ type: 'text', text: JSON.stringify({ learnable: 'yes' }) }] })
    const res = await classifyOperatorMessage({
      operatorText: 'We only use online payment.',
      prefilter,
      previousCayeText: null,
      workspaceId: 'ws-1',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/schema validation failed/)
  })

  it('returns a typed error, never throws, when the underlying call rejects (network/timeout)', async () => {
    responseFactory = () => {
      throw new Error('timeout after 30000ms')
    }
    const res = await classifyOperatorMessage({
      operatorText: 'We only use online payment.',
      prefilter,
      previousCayeText: null,
      workspaceId: 'ws-1',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/classifier call failed/)
  })
})
