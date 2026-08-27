import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { readRoutineInferenceConfig, runInference } from './routine-inference'

const config = {
  enabled: true,
  baseUrl: 'https://routine.example/v1',
  apiKey: 'routine-secret-do-not-log',
  model: 'small-model',
  timeoutMs: 25,
}
const routine = <T = string>(parse: (content: string) => { kind: 'output'; value: T } | { kind: 'escalate' } = ((content: string) => ({ kind: 'output' as const, value: content as T }))) => ({
  messages: [{ role: 'user' as const, content: 'safe bounded task' }],
  parse,
})

afterEach(() => vi.unstubAllGlobals())

describe('routine inference routing', () => {
  it('uses the current frontier path when routine configuration is absent', async () => {
    const frontier = vi.fn(async () => 'frontier')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(runInference({ tier: 'routine', frontier, routine: routine(), config: readRoutineInferenceConfig({}) })).resolves.toBe('frontier')
    expect(fetch).not.toHaveBeenCalled()
    expect(frontier).toHaveBeenCalledOnce()
  })

  it('uses a successful OpenAI-compatible routine response', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'routine result' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const frontier = vi.fn(async () => 'frontier')

    await expect(runInference({ tier: 'routine', frontier, routine: routine(), config })).resolves.toBe('routine result')
    expect(frontier).not.toHaveBeenCalled()
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://routine.example/v1/chat/completions')
  })

  it.each([
    ['provider failure', async () => new Response('unavailable', { status: 503 }), 'routine_provider_error'],
    ['transport failure', async () => { throw new Error('network failed') }, 'routine_transport_error'],
    ['malformed output', async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }), 'routine_malformed_output'],
    ['empty output', async () => new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }), { status: 200 }), 'routine_empty_output'],
  ])('falls back on %s', async (_name, response, reason) => {
    vi.stubGlobal('fetch', vi.fn(response))
    const metadata = vi.fn()
    await expect(runInference({ tier: 'routine', frontier: async () => 'frontier', routine: routine(), config, onMetadata: metadata })).resolves.toBe('frontier')
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ actualTier: 'frontier', fallbackOccurred: true, fallbackReason: reason }))
  })

  it('falls back when the routine provider times out', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))))
    const metadata = vi.fn()
    await expect(runInference({ tier: 'routine', frontier: async () => 'frontier', routine: routine(), config, onMetadata: metadata })).resolves.toBe('frontier')
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ fallbackReason: 'routine_timeout' }))
  })

  it('reruns at frontier after explicit structured escalation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"escalate"}' } }] }), { status: 200 })))
    const frontier = vi.fn(async () => 'frontier')
    const parse = (content: string) => JSON.parse(content) as { kind: 'escalate' }
    await expect(runInference({ tier: 'routine', frontier, routine: routine(parse), config })).resolves.toBe('frontier')
    expect(frontier).toHaveBeenCalledOnce()
  })

  it('never contacts the routine provider for frontier-requested work', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(runInference({ tier: 'frontier', frontier: async () => 'frontier', routine: routine(), config })).resolves.toBe('frontier')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not expose API keys in metadata or routine errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 500 })))
    const metadata = vi.fn()
    await runInference({ tier: 'routine', frontier: async () => 'frontier', routine: routine(), config, onMetadata: metadata })
    expect(JSON.stringify(metadata.mock.calls)).not.toContain(config.apiKey)
  })
})
