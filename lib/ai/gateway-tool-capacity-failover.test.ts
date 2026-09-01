import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * End-to-end reproduction of the 2026-09-01 operator outage, at the gateway
 * boundary: Anthropic exhausted, OpenAI over its tool cap, OpenRouter healthy.
 *
 * Before the fix the OpenAI 400 classified as `malformed_request`
 * (failover: false) and the whole route ended there, so `Switch to ods` came
 * back as "Sorry, I hit a snag with that". The operator turn must instead be
 * served by OpenRouter.
 */

const healthRows: Record<string, unknown>[] = []
const settingsRows: Record<string, unknown>[] = []
const inserted: Record<string, unknown>[] = []

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      return {
        select: async () => ({
          data: table === 'ai_provider_health' ? healthRows : settingsRows,
          error: null,
        }),
        insert: async (row: Record<string, unknown>) => {
          inserted.push({ table, ...row })
          return { error: null }
        },
        upsert: async () => ({ error: null }),
      }
    },
  }),
}))

const { generate } = await import('./gateway')
const { setProviderAdapters } = await import('./providers')
const { resetHealthCache } = await import('./health')
const { resetProviderSettingsCache } = await import('./provider-settings')
const { FakeProvider, httpError } = await import('./test-support')
type FakeProvider = InstanceType<typeof FakeProvider>

let restore: (() => void) | null = null

/** Verbatim from the production llm_call_log attempt trail. */
const TOOLS_OVER_CAP = httpError(
  400,
  "openai request failed (400): {\"error\": {\"message\": \"Invalid 'tools': array too long. " +
    'Expected an array with maximum length 128, but got an array with length 129 instead.", ' +
    '"type": "invalid_request_error", "param": "tools", "code": "array_above_max_length"}}'
)

const ANTHROPIC_EXHAUSTED = httpError(
  400,
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is ' +
    'too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'
)

const OPERATOR_TURN = {
  model: 'auto' as const,
  max_tokens: 1024,
  messages: [{ role: 'user' as const, content: 'Switch to ods' }],
  tools: Array.from({ length: 129 }, (_, i) => ({
    name: `tool_${i}`,
    description: `tool ${i}`,
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  })),
}

beforeEach(() => {
  healthRows.length = 0
  settingsRows.length = 0
  inserted.length = 0
  resetHealthCache()
  resetProviderSettingsCache()
})

afterEach(() => {
  restore?.()
  restore = null
})

describe('operator turn survives Anthropic outage + OpenAI tool cap', () => {
  it('falls through to OpenRouter instead of failing the turn', async () => {
    const anthropic = new FakeProvider('anthropic', { behaviour: [ANTHROPIC_EXHAUSTED] })
    const openai = new FakeProvider('openai', { behaviour: [TOOLS_OVER_CAP] })
    const openrouter = new FakeProvider('openrouter')
    restore = setProviderAdapters({ anthropic, openai, openrouter })

    const result = await generate({
      params: OPERATOR_TURN as never,
      ctx: {
        source: 'app/api/webhooks/whatsapp-operator/route.ts:back-office',
        task: 'agent_planning',
        callerRole: 'founder',
      },
    })

    expect(result.routing.provider).toBe('openrouter')
    expect(result.routing.fellBack).toBe(true)
    expect(openrouter.calls.length).toBe(1)

    // The attempt trail must record why each earlier provider was passed
    // over — that trail is what made this outage diagnosable at all.
    const outcomes = result.routing.attempts.map((a) => `${a.provider}:${a.outcome}`)
    expect(outcomes.some((o) => o.startsWith('anthropic:'))).toBe(true)
    expect(outcomes.some((o) => o.startsWith('openai:'))).toBe(true)
  })

  it('records the tool-capacity rejection without opening the OpenAI circuit', async () => {
    const anthropic = new FakeProvider('anthropic', { behaviour: [ANTHROPIC_EXHAUSTED] })
    const openai = new FakeProvider('openai', { behaviour: [TOOLS_OVER_CAP] })
    restore = setProviderAdapters({
      anthropic,
      openai,
      openrouter: new FakeProvider('openrouter'),
    })

    await generate({
      params: OPERATOR_TURN as never,
      ctx: { source: 'test', task: 'agent_planning', callerRole: 'founder' },
    })

    // OpenAI is healthy — it just cannot hold 129 tools. Quarantining it
    // would wrongly divert every *other* task away from it too.
    const openaiCooldown = inserted.find(
      (row) => row.table === 'ai_provider_health' && row.provider === 'openai' && row.state === 'cooldown'
    )
    expect(openaiCooldown).toBeUndefined()
  })

  it('still serves a normal-sized operator turn on OpenAI when Anthropic is down', async () => {
    const anthropic = new FakeProvider('anthropic', { behaviour: [ANTHROPIC_EXHAUSTED] })
    const openai = new FakeProvider('openai')
    restore = setProviderAdapters({
      anthropic,
      openai,
      openrouter: new FakeProvider('openrouter'),
    })

    const result = await generate({
      params: { ...OPERATOR_TURN, tools: OPERATOR_TURN.tools.slice(0, 40) } as never,
      ctx: { source: 'test', task: 'agent_planning', callerRole: 'founder' },
    })

    expect(result.routing.provider).toBe('openai')
  })
})
