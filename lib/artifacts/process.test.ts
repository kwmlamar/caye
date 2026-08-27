import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const describeImage = vi.hoisted(() => vi.fn())
const extractDocument = vi.hoisted(() => vi.fn())
vi.mock('./understand', () => ({ describeImage, extractDocument }))

const downloadArtifactBytes = vi.hoisted(() => vi.fn().mockResolvedValue(Buffer.from('bytes')))
vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>()
  return { ...actual, downloadArtifactBytes }
})

/**
 * Generic in-memory fake covering both tables process.ts touches.
 *
 * The critical property this fake must get right: an UPDATE's WHERE clause
 * is evaluated, and the row mutated, SYNCHRONOUSLY at the moment `.select()`
 * (or the bare await) is invoked — exactly like a real atomic
 * `UPDATE ... WHERE ... RETURNING`. Two "concurrent" callers racing through
 * this single-threaded fake will therefore genuinely only let ONE of them
 * see a match, the same way Postgres's row lock would arbitrate two real
 * concurrent transactions — this is what makes the concurrency tests below
 * meaningful rather than trivially green.
 *
 * `select().maybeSingle()` returns a SHALLOW COPY of the row, not a live
 * reference — mimicking a real query snapshot. This matters for the
 * older-processing_version test: code that read version 1 must not see a
 * later external bump to version 2 retroactively through object aliasing.
 */
function fakeSupabase(opts: {
  artifacts: Array<Record<string, unknown>>
  observations?: Array<Record<string, unknown>>
  onFirstArtifactSelect?: () => void
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    business_artifacts: opts.artifacts,
    business_artifact_observations: opts.observations ?? [],
  }
  const insertCalls: Array<{ table: string; payload: Record<string, unknown> }> = []
  const updateCalls: Array<{ table: string; payload: Record<string, unknown>; matched: number }> = []
  let firstArtifactSelectHook = opts.onFirstArtifactSelect

  function makeSelectChain(table: string) {
    let filtered = tables[table]
    const chain: Record<string, unknown> = {}
    chain.eq = vi.fn((col: string, val: unknown) => {
      filtered = filtered.filter((r) => r[col] === val)
      return chain
    })
    chain.is = vi.fn((col: string, val: unknown) => {
      filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val))
      return chain
    })
    chain.in = vi.fn((col: string, vals: unknown[]) => {
      filtered = filtered.filter((r) => vals.includes(r[col]))
      return chain
    })
    chain.limit = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => {
      const snapshot = filtered[0] ? { ...filtered[0] } : null
      if (table === 'business_artifacts' && firstArtifactSelectHook) {
        const hook = firstArtifactSelectHook
        firstArtifactSelectHook = undefined
        hook()
      }
      return Promise.resolve({ data: snapshot, error: null })
    })
    chain.then = (onfulfilled?: (v: unknown) => unknown) =>
      Promise.resolve({ data: filtered.map((r) => ({ ...r })), error: null }).then(onfulfilled)
    return chain
  }

  function makeUpdateChain(table: string, payload: Record<string, unknown>) {
    let predicate: (r: Record<string, unknown>) => boolean = () => true
    const addFilter = (fn: (r: Record<string, unknown>) => boolean) => {
      const prev = predicate
      predicate = (r) => prev(r) && fn(r)
    }
    const chain: Record<string, unknown> = {}
    chain.eq = vi.fn((col: string, val: unknown) => {
      addFilter((r) => r[col] === val)
      return chain
    })
    chain.in = vi.fn((col: string, vals: unknown[]) => {
      addFilter((r) => vals.includes(r[col]))
      return chain
    })
    chain.lt = vi.fn((col: string, val: unknown) => {
      addFilter((r) => r[col] != null && (r[col] as string) < (val as string))
      return chain
    })
    const apply = () => {
      const matched = tables[table].filter(predicate)
      matched.forEach((r) => Object.assign(r, payload))
      updateCalls.push({ table, payload, matched: matched.length })
      return matched.map((r) => ({ ...r }))
    }
    chain.select = vi.fn(() => Promise.resolve({ data: apply(), error: null }))
    chain.then = (onfulfilled?: (v: unknown) => unknown) => Promise.resolve({ error: null, data: apply() }).then(onfulfilled)
    return chain
  }

  const from = vi.fn((table: string) => ({
    select: vi.fn(() => makeSelectChain(table)),
    update: vi.fn((payload: Record<string, unknown>) => makeUpdateChain(table, payload)),
    insert: vi.fn((payload: Record<string, unknown>) => {
      insertCalls.push({ table, payload })
      // Mirrors business_artifact_observations_active_model_unique_idx: one
      // active row per (artifact_id, observation_type, model_version) where
      // model_version is not null. This is the actual enforcement behind
      // the "expired lease reclaimed while original worker still running"
      // scenario — see the "L2" test below.
      if (table === 'business_artifact_observations' && payload.model_version != null) {
        const conflict = tables[table].some(
          (r) =>
            r.artifact_id === payload.artifact_id &&
            r.observation_type === payload.observation_type &&
            r.model_version === payload.model_version &&
            r.superseded_at == null
        )
        if (conflict) return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } })
      }
      tables[table].push({ id: `row-${tables[table].length + 1}`, ...payload })
      return Promise.resolve({ error: null })
    }),
  }))

  return { client: { from }, tables, insertCalls, updateCalls }
}

let currentClient: ReturnType<typeof fakeSupabase>['client']
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => currentClient }))

import { processArtifact } from './process'

function baseArtifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact-1',
    workspace_id: 'ws-1',
    modality: 'image',
    detected_mime_type: 'image/jpeg',
    storage_path: 'ws-1/artifact-1/original.jpg',
    storage_state: 'stored',
    processing_status: 'pending',
    processing_version: 1,
    processing_claim_token: null,
    processing_claimed_at: null,
    ...overrides,
  }
}

beforeEach(() => {
  describeImage.mockReset().mockResolvedValue({ ok: true, value: { description: 'a photo', visible_text: null, business_observations: [], confidence: 0.8 } })
  extractDocument.mockReset().mockResolvedValue({ ok: true, value: { summary: 'a doc', full_text: 'text', page_count: 1, key_fields: {} } })
  downloadArtifactBytes.mockReset().mockResolvedValue(Buffer.from('bytes'))
})

describe('BLOCKER 1 corollary — processing never runs ahead of confirmed storage', () => {
  it('M: refuses to process an artifact whose bytes are not confirmed durable', async () => {
    const fake = fakeSupabase({ artifacts: [baseArtifact({ storage_state: 'pending' })] })
    currentClient = fake.client

    const result = await processArtifact('artifact-1')
    expect(result.ok).toBe(false)
    expect(describeImage).not.toHaveBeenCalled()
  })
})

describe('BLOCKER 2 — atomic processing claim (#87 tests E/F/G/H/K/L)', () => {
  it('E: two concurrent processArtifact calls perform understanding exactly once', async () => {
    const fake = fakeSupabase({ artifacts: [baseArtifact()] })
    currentClient = fake.client

    const [a, b] = await Promise.all([processArtifact('artifact-1'), processArtifact('artifact-1')])

    expect([a.ok, b.ok]).toEqual([true, true])
    expect(describeImage).toHaveBeenCalledTimes(1)
    const activeDescriptions = fake.tables.business_artifact_observations.filter(
      (o) => o.observation_type === 'visual_description' && o.superseded_at == null
    )
    expect(activeDescriptions).toHaveLength(1)
    expect(fake.tables.business_artifacts[0].processing_status).toBe('completed')
  })

  it('F: an expired processing lease is reclaimed by a later call', async () => {
    const stale = baseArtifact({
      processing_status: 'processing',
      processing_claim_token: 'stale-token',
      processing_claimed_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(), // > 5min LEASE_MS
    })
    const fake = fakeSupabase({ artifacts: [stale] })
    currentClient = fake.client

    const result = await processArtifact('artifact-1')
    expect(result.ok).toBe(true)
    expect(describeImage).toHaveBeenCalledTimes(1)
    expect(fake.tables.business_artifacts[0].processing_status).toBe('completed')
  })

  it('G: a live (non-expired) processing lease is left alone — a second caller does not claim it', async () => {
    const live = baseArtifact({
      processing_status: 'processing',
      processing_claim_token: 'live-token',
      processing_claimed_at: new Date(Date.now() - 30 * 1000).toISOString(), // well within LEASE_MS
    })
    const fake = fakeSupabase({ artifacts: [live] })
    currentClient = fake.client

    const result = await processArtifact('artifact-1')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.skipped).toBe(true)
    expect(describeImage).not.toHaveBeenCalled()
    // The live lease is untouched — still owned by whoever holds 'live-token'.
    expect(fake.tables.business_artifacts[0].processing_claim_token).toBe('live-token')
  })

  it('H: processing that genuinely failed can retry safely and succeed', async () => {
    const fake = fakeSupabase({ artifacts: [baseArtifact({ processing_status: 'failed' })] })
    currentClient = fake.client
    describeImage.mockResolvedValueOnce({ ok: false, reason: 'model timeout' })

    const first = await processArtifact('artifact-1')
    expect(first.ok).toBe(false)
    expect(fake.tables.business_artifacts[0].processing_status).toBe('failed')

    const second = await processArtifact('artifact-1')
    expect(second.ok).toBe(true)
    expect(fake.tables.business_artifacts[0].processing_status).toBe('completed')
  })

  it('K: completed processing is idempotent — re-processing is a pure no-op', async () => {
    const fake = fakeSupabase({
      artifacts: [baseArtifact({ processing_status: 'completed' })],
      observations: [
        { id: 'obs-1', artifact_id: 'artifact-1', observation_type: 'visual_description', model_version: 'image-v1', superseded_at: null },
      ],
    })
    currentClient = fake.client

    const result = await processArtifact('artifact-1')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.skipped).toBe(true)
    expect(describeImage).not.toHaveBeenCalled()
    expect(fake.insertCalls).toHaveLength(0)
  })

  it('L: a stale (older) processing_version snapshot cannot win a claim against a since-bumped row', async () => {
    const row = baseArtifact({ processing_version: 1, processing_status: 'pending' })
    const fake = fakeSupabase({
      artifacts: [row],
      // Simulates a concurrent reprocess bumping the row to version 2 in the
      // gap between processArtifact's initial read and its claim attempt —
      // the read already captured version=1 by value (shallow copy), so its
      // claim UPDATE's `eq('processing_version', 1)` must miss the live row.
      onFirstArtifactSelect: () => {
        fake.tables.business_artifacts[0].processing_version = 2
        fake.tables.business_artifacts[0].processing_status = 'pending'
      },
    })
    currentClient = fake.client

    const result = await processArtifact('artifact-1')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.skipped).toBe(true) // lost the claim — never ran understanding against the stale version
    expect(describeImage).not.toHaveBeenCalled()
    // The row is untouched by the stale caller — still at the newer generation.
    expect(fake.tables.business_artifacts[0].processing_version).toBe(2)
    expect(fake.tables.business_artifacts[0].processing_claim_token).toBeFalsy()
  })

  it('scenario 9: an old worker finishing AFTER a newer worker reclaimed the lease cannot clobber the newer state or duplicate the observation', async () => {
    const fake = fakeSupabase({ artifacts: [baseArtifact()] })
    currentClient = fake.client

    // Worker A claims first, then pauses mid-model-call (deferred, under our
    // control) — simulating a legitimately slow understanding pass.
    let resolveA!: (v: unknown) => void
    const deferredA = new Promise((resolve) => {
      resolveA = resolve
    })
    describeImage.mockImplementationOnce(() => deferredA)

    const promiseA = processArtifact('artifact-1')
    await new Promise((r) => setTimeout(r, 0)) // let A reach its describeImage call and pause there
    expect(describeImage).toHaveBeenCalledTimes(1)
    expect(fake.tables.business_artifacts[0].processing_status).toBe('processing')
    const tokenA = fake.tables.business_artifacts[0].processing_claim_token
    expect(tokenA).toBeTruthy()

    // Simulate A's lease expiring (it's been "running" longer than LEASE_MS)
    // while it is still legitimately in flight.
    fake.tables.business_artifacts[0].processing_claimed_at = new Date(Date.now() - 6 * 60 * 1000).toISOString()

    // Worker B reclaims and completes normally — its own describeImage call
    // falls through to the default (immediate) mock from beforeEach.
    const resultB = await processArtifact('artifact-1')
    expect(resultB.ok).toBe(true)
    if (!resultB.ok) throw new Error('unreachable')
    expect(resultB.skipped).toBe(false)
    expect(fake.tables.business_artifacts[0].processing_status).toBe('completed')
    const tokenAfterB = fake.tables.business_artifacts[0].processing_claim_token

    // NOW worker A finishes its (stale) model call and tries to land its result.
    resolveA({ ok: true, value: { description: 'a photo (from A)', visible_text: null, business_observations: [], confidence: 0.8 } })
    const resultA = await promiseA
    expect(resultA.ok).toBe(true)

    // The row must still reflect B's completion — A's release used a token
    // that no longer matches (B's release already cleared/overwrote it), so
    // A's own release update is a structural no-op.
    expect(fake.tables.business_artifacts[0].processing_status).toBe('completed')
    expect(fake.tables.business_artifacts[0].processing_claim_token).toBe(tokenAfterB)

    // Exactly ONE active visual_description observation exists — A's insert
    // collided with B's on the unique (artifact_id, observation_type,
    // model_version) index and was correctly treated as a benign duplicate,
    // never a second active observation.
    const activeDescriptions = fake.tables.business_artifact_observations.filter(
      (o) => o.observation_type === 'visual_description' && o.superseded_at == null
    )
    expect(activeDescriptions).toHaveLength(1)
  })
})

describe('BUG 3 — unsupported modality is never overwritten to completed (#87 test J)', () => {
  it('J: a non-PDF document is marked unsupported and stays unsupported, with no fabricated observations', async () => {
    const fake = fakeSupabase({
      artifacts: [baseArtifact({ modality: 'document', detected_mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })],
    })
    currentClient = fake.client

    const result = await processArtifact('artifact-1')

    expect(result.ok).toBe(true)
    expect(result.status).toBe('unsupported')
    expect(fake.tables.business_artifacts[0].processing_status).toBe('unsupported')
    expect(extractDocument).not.toHaveBeenCalled()
    expect(fake.insertCalls).toHaveLength(0) // no fake understanding observations

    // A later call must skip cleanly, never flip to 'completed'.
    const second = await processArtifact('artifact-1')
    expect(second.ok).toBe(true)
    expect(second.status).toBe('unsupported')
    expect(fake.tables.business_artifacts[0].processing_status).toBe('unsupported')
  })

  it('an unsupported modality (audio) behaves the same way', async () => {
    const fake = fakeSupabase({ artifacts: [baseArtifact({ modality: 'audio', detected_mime_type: 'audio/ogg' })] })
    currentClient = fake.client

    const result = await processArtifact('artifact-1')
    expect(result.status).toBe('unsupported')
    expect(fake.tables.business_artifacts[0].processing_status).toBe('unsupported')
  })
})

describe('observation idempotency on retry (#87 test I)', () => {
  it('a document whose extraction succeeded but summary insert failed retries and lands ONLY the missing summary — no duplicate extraction', async () => {
    const fake = fakeSupabase({
      artifacts: [baseArtifact({ modality: 'document', detected_mime_type: 'application/pdf' })],
      observations: [
        {
          id: 'obs-extraction',
          artifact_id: 'artifact-1',
          observation_type: 'document_extraction',
          model_version: 'document-v1',
          superseded_at: null,
        },
      ],
    })
    currentClient = fake.client

    const result = await processArtifact('artifact-1')

    expect(result.ok).toBe(true)
    expect(result.status).toBe('completed')
    // Extraction was already there — must not be inserted a second time.
    const extractionRows = fake.tables.business_artifact_observations.filter(
      (o) => o.observation_type === 'document_extraction' && o.superseded_at == null
    )
    expect(extractionRows).toHaveLength(1)
    // The missing summary must actually get written, not silently skipped.
    const summaryRows = fake.tables.business_artifact_observations.filter((o) => o.observation_type === 'summary')
    expect(summaryRows).toHaveLength(1)
  })

  it('retrying after a genuinely failed model call does not insert a partial/duplicate observation set', async () => {
    const fake = fakeSupabase({ artifacts: [baseArtifact({ modality: 'document', detected_mime_type: 'application/pdf' })] })
    currentClient = fake.client
    extractDocument.mockResolvedValueOnce({ ok: false, reason: 'model call failed' })

    const first = await processArtifact('artifact-1')
    expect(first.ok).toBe(false)
    expect(fake.insertCalls).toHaveLength(0)

    const second = await processArtifact('artifact-1')
    expect(second.ok).toBe(true)
    const extractionRows = fake.tables.business_artifact_observations.filter((o) => o.observation_type === 'document_extraction')
    const summaryRows = fake.tables.business_artifact_observations.filter((o) => o.observation_type === 'summary')
    expect(extractionRows).toHaveLength(1)
    expect(summaryRows).toHaveLength(1)
  })
})
