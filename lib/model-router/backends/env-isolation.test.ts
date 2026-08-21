import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * "Credentials remain local. Caye/Vercel must never receive Claude or
 * Codex subscription credentials" — this asserts the actual env object
 * each CLI subprocess is spawned with (minimalEnv(), private to each
 * backend module) never contains anything credential-shaped, by testing
 * it against a polluted process.env that includes exactly the kind of
 * product secrets this repo actually uses (ANTHROPIC_API_KEY, Supabase
 * service role key, WhatsApp tokens) plus generic KEY/SECRET/TOKEN-shaped
 * env vars. minimalEnv() isn't exported — this drives it indirectly via
 * checkHealth(), the cheapest real call that constructs and uses it, with
 * runSubprocess itself mocked so no real process is spawned.
 */
const calls: { env: NodeJS.ProcessEnv }[] = []
vi.mock('./subprocess', () => ({
  runSubprocess: vi.fn(async (opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ env: opts.env })
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
  }),
  SubprocessSpawnError: class SubprocessSpawnError extends Error {
    code?: string
  },
}))

const originalEnv = { ...process.env }

beforeEach(() => {
  calls.length = 0
  delete process.env.VERCEL
  process.env.CAYE_DIRECT_LOCAL_BRIDGE = '1'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-should-never-leak'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-should-never-leak'
  process.env.WHATSAPP_ACCESS_TOKEN = 'whatsapp-token-should-never-leak'
  process.env.OPENAI_API_KEY = 'sk-openai-should-never-leak'
  process.env.SOME_RANDOM_SECRET = 'random-secret-should-never-leak'
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('CLI backend env isolation', () => {
  it('claude_subscription spawns with an env free of every non-CLI credential', async () => {
    const { ClaudeSubscriptionBackend } = await import('./claude-subscription')
    await new ClaudeSubscriptionBackend().checkHealth()

    expect(calls).toHaveLength(1)
    assertNoLeakedSecrets(calls[0].env)
  })

  it('openai_codex_subscription spawns with an env free of every non-CLI credential', async () => {
    const { OpenAICodexSubscriptionBackend } = await import('./openai-codex-subscription')
    await new OpenAICodexSubscriptionBackend().checkHealth()

    expect(calls).toHaveLength(1)
    assertNoLeakedSecrets(calls[0].env)
  })
})

function assertNoLeakedSecrets(env: NodeJS.ProcessEnv): void {
  const allowed = new Set(['PATH', 'NODE_ENV', 'HOME', 'USER', 'LOGNAME', 'CLAUDE_CONFIG_DIR'])
  for (const key of Object.keys(env)) {
    expect(allowed.has(key)).toBe(true)
  }
  expect(JSON.stringify(env)).not.toContain('should-never-leak')
}
