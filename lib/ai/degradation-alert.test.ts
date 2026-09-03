import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * Provider-degradation alerting, proved end-to-end through the real gateway
 * rather than by calling the alerter directly. The whole point of the change
 * is *which gateway decisions* page a human, so a test that skipped the
 * gateway would prove nothing about the 2026-09-02 outage it exists for.
 *
 * Nothing here sends mail: lib/email/founder-mailer is mocked, so the suite
 * asserts on captured envelopes and there is no live Resend call.
 */

/** Captured founder emails. No transport is exercised. */
const sentEmails: { to: string; subject: string; body: string }[] = []
vi.mock('@/lib/email/founder-mailer', () => ({
  sendFounderAlertEmail: async (args: { to: string; subject: string; body: string }) => {
    sentEmails.push(args)
    return { ok: true }
  },
}))

/** Alert-log dedup keys already claimed, mirroring the table's primary key. */
const claimedAlertKeys = new Set<string>()
const healthRows: Record<string, unknown>[] = []
const telemetryRows: Record<string, unknown>[] = []
let founderEmail: string | null = 'founder@example.test'
let alertLogInsertError: { code?: string; message: string } | null = null

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const selectResult = {
        data: table === 'ai_provider_health' ? healthRows : [],
        error: null as unknown,
      }
      const chain = {
        // platform_settings uses .select().eq().maybeSingle()
        eq: () => chain,
        maybeSingle: async () =>
          table === 'platform_settings' && founderEmail !== null
            ? { data: { value: founderEmail }, error: null }
            : { data: null, error: null },
        // health/settings await .select() directly
        then: (resolve: (v: typeof selectResult) => unknown) => resolve(selectResult),
      }
      return {
        select: () => chain,
        insert: async (row: Record<string, unknown>) => {
          if (table === 'caye_founder_alert_log') {
            if (alertLogInsertError) return { error: alertLogInsertError }
            const key = String(row.alert_key)
            if (claimedAlertKeys.has(key)) return { error: { code: '23505', message: 'duplicate key' } }
            claimedAlertKeys.add(key)
            return { error: null }
          }
          telemetryRows.push({ table, ...row })
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
const { isAccountFatal, isUserFacingTask, redactSecrets, accountFatalFallbackCause } = await import(
  './degradation-alert'
)
type FakeProvider = InstanceType<typeof FakeProvider>

let restore: (() => void) | null = null

function install(providers: { anthropic?: FakeProvider; openai?: FakeProvider; openrouter?: FakeProvider }) {
  restore?.()
  restore = setProviderAdapters({
    anthropic: providers.anthropic ?? new FakeProvider('anthropic'),
    openai: providers.openai ?? new FakeProvider('openai'),
    openrouter: providers.openrouter ?? new FakeProvider('openrouter'),
  })
}

/**
 * The exact body Anthropic returned throughout the 2026-09-02 outage, HTTP
 * 400. Kept verbatim so this suite is regression coverage for the real
 * incident rather than for a paraphrase of it.
 */
const REAL_BILLING_ERROR = httpError(
  400,
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'
)

const params = { model: 'ignored', max_tokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] }

/** Alerting is fire-and-forget; drain the microtask queue like gateway.test.ts does. */
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  sentEmails.length = 0
  claimedAlertKeys.clear()
  healthRows.length = 0
  telemetryRows.length = 0
  founderEmail = 'founder@example.test'
  alertLogInsertError = null
  resetHealthCache()
  resetProviderSettingsCache()
})

afterEach(() => {
  restore?.()
  restore = null
  vi.unstubAllEnvs()
})

describe('severity is read from FAILURE_POLICY, not redefined', () => {
  it('treats single-strike circuit openers as account-fatal', () => {
    expect(isAccountFatal('billing_exhausted')).toBe(true)
    expect(isAccountFatal('authentication')).toBe(true)
    expect(isAccountFatal('quota')).toBe(true)
  })

  it('does not treat threshold-3 transients as account-fatal', () => {
    // rate_limit opens a circuit too, but only after repetition — that
    // distinction is the whole reason this derives from policy.
    expect(isAccountFatal('rate_limit')).toBe(false)
    expect(isAccountFatal('upstream_5xx')).toBe(false)
    expect(isAccountFatal('timeout')).toBe(false)
    expect(isAccountFatal('network')).toBe(false)
  })

  it('does not treat request-shaped failures as degradation at all', () => {
    expect(isAccountFatal('malformed_request')).toBe(false)
    expect(isAccountFatal('content_policy')).toBe(false)
    expect(isAccountFatal('invalid_tool_or_schema')).toBe(false)
  })
})

describe('account-fatal alerting', () => {
  it('alerts on the first billing_exhausted failure, even though the request succeeds elsewhere', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [REAL_BILLING_ERROR] }),
      openai: new FakeProvider('openai'),
    })

    const result = await generate({
      params,
      ctx: { source: 'lib/caye-reply.ts:generateCayeAutoReply', task: 'customer_response', workspaceId: 'ws-1' },
    })
    await flush()

    // The request still succeeded — silent failover is correct and unchanged.
    expect(result.routing.provider).toBe('openai')

    const accountAlert = sentEmails.find((e) => e.subject.includes('account-down'))
    expect(accountAlert).toBeDefined()
    expect(accountAlert!.to).toBe('founder@example.test')
    expect(accountAlert!.subject).toContain('anthropic')
    expect(accountAlert!.subject).toContain('billing_exhausted')
    expect(accountAlert!.body).toContain('credit balance is too low')
  })

  it('deduplicates repeats within the same incident window', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [REAL_BILLING_ERROR] }),
      openai: new FakeProvider('openai'),
    })
    const ctx = { source: 'lib/caye-reply.ts:generateCayeAutoReply', task: 'customer_response' as const }

    for (let i = 0; i < 5; i++) {
      await generate({ params, ctx })
      resetHealthCache() // force each call to re-attempt anthropic, as a new lambda would
      await flush()
    }

    // Five failing calls, one account-down alert. This is the "do not send an
    // alert for every model call during the same outage" requirement — during
    // the real incident this path ran hundreds of times.
    expect(sentEmails.filter((e) => e.subject.includes('account-down'))).toHaveLength(1)
  })

  it('stays silent for a transient failure that fails over', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [httpError(503, 'upstream unavailable')] }),
      openai: new FakeProvider('openai'),
    })

    await generate({ params, ctx: { source: 'test', task: 'customer_response' } })
    await flush()

    // Normal failover is already in llm_call_log. Paging on it is how an
    // alert mailbox becomes noise and a real outage goes unread.
    expect(sentEmails).toHaveLength(0)
  })
})

describe('user-facing fallback is observable', () => {
  it('alerts when customer-facing traffic changes vendor because an account died', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [REAL_BILLING_ERROR] }),
      openai: new FakeProvider('openai'),
    })

    await generate({
      params,
      ctx: { source: 'lib/caye-reply.ts:generateCayeAutoReply', task: 'customer_response', workspaceId: 'ws-42' },
    })
    await flush()

    const fallback = sentEmails.find((e) => e.subject.includes('user-facing traffic moved off'))
    expect(fallback).toBeDefined()
    expect(fallback!.subject).toContain('customer_response')
    expect(fallback!.body).toContain('openai')
    expect(fallback!.body).toContain('ws-42')
  })

  it('does not raise a user-facing alert for a background task', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [REAL_BILLING_ERROR] }),
      openai: new FakeProvider('openai'),
    })

    await generate({
      params,
      ctx: { source: 'lib/business-learning/extract.ts:extractBusinessLearning', task: 'fact_extraction' },
    })
    await flush()

    // The dead account is still reported; the customer-impact alert is not,
    // because no person was waiting on this one.
    expect(sentEmails.some((e) => e.subject.includes('account-down'))).toBe(true)
    expect(sentEmails.some((e) => e.subject.includes('user-facing traffic moved off'))).toBe(false)
  })

  it('classifies which tasks count as user-facing', () => {
    expect(isUserFacingTask('customer_response')).toBe(true)
    expect(isUserFacingTask('operator_response')).toBe(true)
    expect(isUserFacingTask('agent_planning')).toBe(true)
    expect(isUserFacingTask('classification')).toBe(false)
    expect(isUserFacingTask('research')).toBe(false)
  })

  it('ignores a fallback caused by something transient', () => {
    const cause = accountFatalFallbackCause({
      task: 'customer_response',
      provider: 'openai',
      model: 'gpt-5',
      fellBack: true,
      latencyMs: 10,
      attempts: [
        { provider: 'anthropic', model: 'claude-sonnet-4-6', outcome: 'upstream_5xx' },
        { provider: 'openai', model: 'gpt-5', outcome: 'success' },
      ],
    })
    expect(cause).toBeNull()
  })

  it('ignores skipped routes when finding the cause', () => {
    const cause = accountFatalFallbackCause({
      task: 'customer_response',
      provider: 'openrouter',
      model: 'openai/gpt-4.1',
      fellBack: true,
      latencyMs: 10,
      attempts: [
        { provider: 'anthropic', model: 'claude-sonnet-4-6', outcome: 'skipped_circuit_open' },
        { provider: 'openai', model: 'gpt-5', outcome: 'authentication' },
        { provider: 'openrouter', model: 'openai/gpt-4.1', outcome: 'success' },
      ],
    })
    expect(cause).toEqual({ from: 'openai', category: 'authentication' })
  })
})

describe('total provider-chain failure', () => {
  it('alerts urgently when nothing served the request', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [REAL_BILLING_ERROR] }),
      openai: new FakeProvider('openai', { behaviour: [httpError(401, 'invalid api key')] }),
      openrouter: new FakeProvider('openrouter', {
        behaviour: [httpError(402, 'This request requires more credits, or fewer max_tokens')],
      }),
    })

    await expect(
      generate({ params, ctx: { source: 'lib/caye-agent/execute.ts:runToolLoop', task: 'agent_planning' } })
    ).rejects.toThrow()
    await flush()

    const urgent = sentEmails.find((e) => e.subject.startsWith('Caye URGENT'))
    expect(urgent).toBeDefined()
    expect(urgent!.body).toContain('nothing served the request')
    // The attempt trail names every provider that was tried, in order.
    expect(urgent!.body).toContain('anthropic')
    expect(urgent!.body).toContain('openai')
    expect(urgent!.body).toContain('openrouter')
  })
})

describe('recovery is observable', () => {
  it('alerts when a provider serves again after cooldown', async () => {
    // Cooldown already elapsed: the circuit is closed so the provider is
    // retried, but its stored state is still 'cooldown' — exactly the
    // transition a recovery is.
    healthRows.push({
      provider: 'anthropic',
      state: 'cooldown',
      reason: 'billing_exhausted',
      cooldown_until: new Date(Date.now() - 60_000).toISOString(),
      consecutive_failures: 1,
    })
    install({ anthropic: new FakeProvider('anthropic') })

    const result = await generate({ params, ctx: { source: 'test', task: 'customer_response' } })
    await flush()

    expect(result.routing.provider).toBe('anthropic')
    const recovered = sentEmails.find((e) => e.subject.includes('serving again'))
    expect(recovered).toBeDefined()
    expect(recovered!.body).toContain('billing_exhausted')
  })

  it('says nothing when a healthy provider simply keeps working', async () => {
    install({ anthropic: new FakeProvider('anthropic') })
    await generate({ params, ctx: { source: 'test', task: 'customer_response' } })
    await flush()
    expect(sentEmails).toHaveLength(0)
  })
})

describe('secret hygiene', () => {
  it('redacts credential shapes from alert bodies', () => {
    expect(redactSecrets('key sk-ant-api03-AAAABBBBCCCCDDDDEEEE failed')).not.toContain('sk-ant-api03')
    expect(redactSecrets('Authorization: Bearer abcdef1234567890abcdef')).not.toContain('abcdef1234567890')
    expect(redactSecrets('{"api_key":"supersecretvalue"}')).not.toContain('supersecretvalue')
    expect(redactSecrets('x-api-key = hunter2hunter2hunter2')).not.toContain('hunter2hunter2hunter2')
    // Long opaque blobs go too, even unlabelled.
    expect(redactSecrets(`token ${'A'.repeat(48)} end`)).not.toContain('A'.repeat(48))
  })

  it('keeps ordinary diagnostic detail readable', () => {
    const text = 'Your credit balance is too low to access the Anthropic API.'
    expect(redactSecrets(text)).toBe(text)
    // Request ids (~27 chars) are below the opaque-blob floor and survive.
    expect(redactSecrets('request_id req_011CefxKngowoMpcpgZ7tn9t')).toContain('req_011CefxKngowoMpcpgZ7tn9t')
  })

  it('never emits a raw credential through the gateway path', async () => {
    install({
      anthropic: new FakeProvider('anthropic', {
        behaviour: [httpError(401, 'invalid x-api-key: sk-ant-api03-LEAKEDKEYVALUE0000000000')],
      }),
      openai: new FakeProvider('openai'),
    })

    await generate({ params, ctx: { source: 'test', task: 'customer_response' } })
    await flush()

    expect(sentEmails.length).toBeGreaterThan(0)
    for (const email of sentEmails) {
      expect(email.body).not.toContain('sk-ant-api03-LEAKEDKEYVALUE0000000000')
      expect(email.body).not.toContain('LEAKEDKEYVALUE')
    }
  })
})

describe('fail-open contract', () => {
  it('serves the request even when the alert log is unwritable', async () => {
    alertLogInsertError = { message: 'db down' }
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [REAL_BILLING_ERROR] }),
      openai: new FakeProvider('openai'),
    })

    const result = await generate({ params, ctx: { source: 'test', task: 'customer_response' } })
    await flush()

    expect(result.routing.provider).toBe('openai')
    expect(sentEmails).toHaveLength(0)
  })

  it('serves the request when no founder_email is configured', async () => {
    founderEmail = null
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [REAL_BILLING_ERROR] }),
      openai: new FakeProvider('openai'),
    })

    const result = await generate({ params, ctx: { source: 'test', task: 'customer_response' } })
    await flush()

    expect(result.routing.provider).toBe('openai')
    expect(sentEmails).toHaveLength(0)
  })

  it('still writes the spend ledger row when alerting fires', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [REAL_BILLING_ERROR] }),
      openai: new FakeProvider('openai'),
    })

    await generate({ params, ctx: { source: 'test', task: 'customer_response' } })
    await flush()

    // Alerting must not displace the existing telemetry — one ledger, as before.
    expect(telemetryRows.some((r) => r.table === 'llm_call_log')).toBe(true)
  })
})
