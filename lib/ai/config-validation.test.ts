import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('server-only', () => ({}))

const { validateAiConfiguration } = await import('./config-validation')
const { setProviderAdapters } = await import('./providers')
const { FakeProvider } = await import('./test-support')

let restore: (() => void) | null = null

function configure(present: ('anthropic' | 'openai' | 'openrouter')[]) {
  restore?.()
  restore = setProviderAdapters({
    anthropic: new FakeProvider('anthropic', { hasKey: present.includes('anthropic') }),
    openai: new FakeProvider('openai', { hasKey: present.includes('openai') }),
    openrouter: new FakeProvider('openrouter', { hasKey: present.includes('openrouter') }),
  })
}

beforeEach(() => configure(['anthropic', 'openai', 'openrouter']))
afterEach(() => {
  restore?.()
  restore = null
})

describe('AI configuration validity', () => {
  it('is valid with all three providers and reports failover coverage', () => {
    const result = validateAiConfiguration()
    expect(result.valid).toBe(true)
    expect(result.singleProviderTasks).toEqual([])
    expect(result.message).toContain('Failover available')
  })

  it('stays valid when ANTHROPIC_API_KEY is missing but OpenAI is configured', () => {
    // The whole point: an unpaid Anthropic account must not be able to stop
    // Caye from starting or serving.
    configure(['openai', 'openrouter'])
    const result = validateAiConfiguration()
    expect(result.valid).toBe(true)
    expect(result.missingProviders).toEqual(['anthropic'])
    expect(result.unroutableTasks).toEqual([])
  })

  it('stays valid with only OpenRouter configured, but warns there is no failover', () => {
    configure(['openrouter'])
    const result = validateAiConfiguration()
    expect(result.valid).toBe(true)
    expect(result.singleProviderTasks.length).toBeGreaterThan(0)
    expect(result.message).toContain('no failover')
  })

  it('is invalid, with a clear message, when nothing is configured', () => {
    configure([])
    const result = validateAiConfiguration()
    expect(result.valid).toBe(false)
    expect(result.unroutableTasks.length).toBeGreaterThan(0)
    expect(result.message).toContain('ANTHROPIC_API_KEY')
    expect(result.message).toContain('OPENAI_API_KEY')
    expect(result.message).toContain('OPENROUTER_API_KEY')
  })

  it('never leaves a task routable by only one vendor when all three keys exist', () => {
    // Guards the route table itself: a new task that only lists Anthropic
    // models would silently re-create the single-vendor coupling.
    expect(validateAiConfiguration().singleProviderTasks).toEqual([])
  })
})
