import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))

const ENV_KEYS = ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'DEEPGRAM_PROJECT_ID', 'ELEVENLABS_API_KEY'] as const

describe('getVoiceCapabilities — capability probe (no network calls)', () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    vi.resetModules()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  it('reports every provider unavailable with a reason when no keys are configured', async () => {
    const { getVoiceCapabilities } = await import('./providers')
    const caps = getVoiceCapabilities()
    expect(caps.stt.every((c) => !c.available)).toBe(true)
    expect(caps.tts.every((c) => !c.available)).toBe(true)
    for (const c of [...caps.stt, ...caps.tts]) {
      expect(c.unavailableReason).toBeTruthy()
    }
  })

  it('marks openai-realtime STT available once OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const { getVoiceCapabilities } = await import('./providers')
    const caps = getVoiceCapabilities()
    const openai = caps.stt.find((c) => c.provider === 'openai-realtime')
    expect(openai?.available).toBe(true)
    expect(openai?.unavailableReason).toBeUndefined()
  })

  it('marks Deepgram STT available with just DEEPGRAM_API_KEY (no project id needed — /v1/auth/grant is account-scoped, not project-scoped; fixed 2026-08-16 after a live smoke test showed the original /v1/projects/:id/keys endpoint needs an admin-level scope this account does not have)', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-test'
    const { getVoiceCapabilities } = await import('./providers')
    const deepgram = getVoiceCapabilities().stt.find((c) => c.provider === 'deepgram')
    expect(deepgram?.available).toBe(true)
    expect(deepgram?.unavailableReason).toBeUndefined()
  })

  it('Deepgram TTS only needs the account API key too (no ephemeral minting on the TTS path — it is proxied)', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-test'
    const { getVoiceCapabilities } = await import('./providers')
    expect(getVoiceCapabilities().tts.find((c) => c.provider === 'deepgram')?.available).toBe(true)
  })

  it('marks elevenlabs TTS available once ELEVENLABS_API_KEY is set', async () => {
    process.env.ELEVENLABS_API_KEY = 'el-test'
    const { getVoiceCapabilities } = await import('./providers')
    expect(getVoiceCapabilities().tts.find((c) => c.provider === 'elevenlabs')?.available).toBe(true)
  })
})

describe('mintSttCredential(\'deepgram\') — regression guard for the 2026-08-16 endpoint fix', () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    vi.resetModules()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    vi.unstubAllGlobals()
  })

  it('calls POST /v1/auth/grant (not the old /v1/projects/:id/keys management endpoint) and never sends a project id anywhere', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-test'
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ access_token: 'ephemeral-jwt', expires_in: 300 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchSpy)

    const { mintSttCredential } = await import('./providers')
    const cred = await mintSttCredential('deepgram')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.deepgram.com/v1/auth/grant')
    expect(url).not.toContain('/projects/')
    expect(JSON.parse(init?.body as string)).toEqual({ ttl_seconds: 300 })
    expect(cred.token).toBe('ephemeral-jwt')
    // 1200ms, not the original 700ms — live-tested 2026-08-17: 700ms split
    // one real sentence into two separate turns on a natural mid-sentence
    // pause. See providers.ts's DEEPGRAM_ENDPOINTING_MS doc comment.
    expect(cred.connect.wsUrl).toContain('endpointing=1200')
    expect(cred.connect.wsUrl).toContain('utterance_end_ms=2000')
  })

  it('surfaces a clear error on 403 rather than silently degrading (this is the exact failure observed live against a real account)', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ err_code: 'FORBIDDEN', err_msg: 'Insufficient permissions.' }), { status: 403 }))
    )
    const { mintSttCredential } = await import('./providers')
    await expect(mintSttCredential('deepgram')).rejects.toThrow(/403/)
  })
})
