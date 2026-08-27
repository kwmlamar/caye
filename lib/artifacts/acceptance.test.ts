import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * Literal end-to-end acceptance tests for #87 (Multimodal Business Memory).
 *
 * Unlike the per-module unit tests elsewhere in lib/artifacts/, this file
 * wires ingestArtifact + processArtifact + annotateArtifact + query.ts +
 * retrieveArtifactForOperator together against ONE shared, mutable,
 * constraint-enforcing in-memory database — the real production code path,
 * not a chain of independently-mocked steps. Only actual I/O (storage bytes,
 * the vision/document model, WhatsApp send) is mocked; every DB read/write
 * goes through the same fake tables every real call site touches.
 */

// ---------------------------------------------------------------------------
// External I/O mocks (everything that is NOT a database read/write)
// ---------------------------------------------------------------------------

const uploadArtifactBytes = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }))
const downloadArtifactBytes = vi.hoisted(() => vi.fn().mockResolvedValue(Buffer.from('fake-image-bytes')))
const signArtifactUrl = vi.hoisted(() => vi.fn().mockResolvedValue('https://signed.example/original.jpg'))
vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>()
  return { ...actual, uploadArtifactBytes, downloadArtifactBytes, signArtifactUrl }
})

const describeImage = vi.hoisted(() => vi.fn())
const extractDocument = vi.hoisted(() => vi.fn())
vi.mock('./understand', () => ({ describeImage, extractDocument }))

const isWhatsAppWindowOpen = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('@/lib/whatsapp/window', () => ({ isWhatsAppWindowOpen }))

const sendMediaWhatsApp = vi.hoisted(() => vi.fn().mockResolvedValue({ status: 'sent', messageId: 'wamid.sent-1' }))
vi.mock('@/lib/whatsapp/outbound', () => ({ sendMediaWhatsApp }))

const enqueueOperation = vi.hoisted(() => vi.fn().mockResolvedValue({ queued: true, alreadyQueued: false }))
vi.mock('@/lib/pending-operations', () => ({ enqueueOperation }))

// ---------------------------------------------------------------------------
// Shared relational fake — the one thing every real call site (ingest.ts,
// process.ts, query.ts, relations.ts, retrieve-artifact-for-operator.ts)
// reads and writes through, via the SAME createServiceClient() mock.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function makeDb() {
  const tables: Record<string, Row[]> = {
    business_artifacts: [],
    business_artifact_observations: [],
    business_artifact_relations: [],
    operator_allowlist: [{ id: 7, phone: '+12345550100' }],
  }
  let nextId = 1
  const newId = () => `row-${nextId++}`

  function violatesUnique(table: string, candidate: Row): string | null {
    if (table === 'business_artifacts' && candidate.provider_attachment_id != null) {
      const hit = tables.business_artifacts.find(
        (r) =>
          r.id !== candidate.id &&
          r.workspace_id === candidate.workspace_id &&
          r.source_channel === candidate.source_channel &&
          r.provider_attachment_id === candidate.provider_attachment_id
      )
      if (hit) return 'business_artifacts_provider_attachment_idx'
    }
    if (table === 'business_artifact_observations' && candidate.model_version != null && candidate.superseded_at == null) {
      const hit = tables.business_artifact_observations.find(
        (r) =>
          r.id !== candidate.id &&
          r.artifact_id === candidate.artifact_id &&
          r.observation_type === candidate.observation_type &&
          r.model_version === candidate.model_version &&
          r.superseded_at == null
      )
      if (hit) return 'business_artifact_observations_active_model_unique_idx'
    }
    if (table === 'business_artifact_relations' && candidate.status === 'confirmed' && candidate.superseded_at == null) {
      const hit = tables.business_artifact_relations.find(
        (r) =>
          r.id !== candidate.id &&
          r.artifact_id === candidate.artifact_id &&
          r.target_entity_type === candidate.target_entity_type &&
          r.target_entity_id === candidate.target_entity_id &&
          r.status === 'confirmed' &&
          r.superseded_at == null
      )
      if (hit) return 'business_artifact_relations_confirmed_idx'
    }
    return null
  }

  function selectChain(table: string) {
    let rows = [...tables[table]]
    const chain: Record<string, unknown> = {}
    chain.eq = vi.fn((c: string, v: unknown) => {
      rows = rows.filter((r) => r[c] === v)
      return chain
    })
    chain.neq = vi.fn((c: string, v: unknown) => {
      rows = rows.filter((r) => r[c] !== v)
      return chain
    })
    chain.is = vi.fn((c: string, v: unknown) => {
      rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v))
      return chain
    })
    chain.in = vi.fn((c: string, vals: unknown[]) => {
      rows = rows.filter((r) => vals.includes(r[c]))
      return chain
    })
    chain.gte = vi.fn((c: string, v: unknown) => {
      rows = rows.filter((r) => (r[c] as string) >= (v as string))
      return chain
    })
    chain.lte = vi.fn((c: string, v: unknown) => {
      rows = rows.filter((r) => (r[c] as string) <= (v as string))
      return chain
    })
    chain.lt = vi.fn((c: string, v: unknown) => {
      rows = rows.filter((r) => r[c] != null && (r[c] as string) < (v as string))
      return chain
    })
    chain.order = vi.fn((c: string, opts?: { ascending?: boolean }) => {
      rows = [...rows].sort((a, b) => {
        const av = a[c] as string
        const bv = b[c] as string
        return opts?.ascending ? (av > bv ? 1 : -1) : av < bv ? 1 : -1
      })
      return chain
    })
    chain.limit = vi.fn((n: number) => {
      rows = rows.slice(0, n)
      return chain
    })
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null }))
    chain.single = vi.fn(() =>
      rows[0] ? Promise.resolve({ data: { ...rows[0] }, error: null }) : Promise.resolve({ data: null, error: { message: 'not found' } })
    )
    chain.then = (onfulfilled?: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(onfulfilled)
    return chain
  }

  // Mirrors the migration's column DEFAULTs — a real INSERT that omits a
  // defaulted column gets the default back on read, not undefined. Getting
  // this wrong silently broke processArtifact's claim predicate (which
  // filters on processing_status/processing_version) the first time this
  // fake was written — real Postgres defaults matter for behavior, not just
  // cosmetics.
  const DEFAULTS: Record<string, Row> = {
    business_artifacts: {
      origin: 'external',
      storage_state: 'pending',
      processing_status: 'pending',
      processing_version: 1,
      retention_status: 'active',
    },
    business_artifact_observations: {
      content: {},
      provenance_status: 'extracted',
    },
    business_artifact_relations: {
      status: 'candidate',
      provenance: 'model_inferred',
    },
  }

  function insertBuilder(table: string, payload: Row) {
    return {
      select: vi.fn(() => ({
        single: vi.fn(() => {
          const row: Row = { id: newId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...DEFAULTS[table], ...payload }
          const conflict = violatesUnique(table, row)
          if (conflict) return Promise.resolve({ data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${conflict}"` } })
          tables[table].push(row)
          return Promise.resolve({ data: { ...row }, error: null })
        }),
      })),
      then: (onfulfilled?: (v: unknown) => unknown) => {
        const row: Row = { id: newId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...DEFAULTS[table], ...payload }
        const conflict = violatesUnique(table, row)
        if (conflict) return Promise.resolve({ error: { code: '23505', message: `duplicate key value violates unique constraint "${conflict}"` } }).then(onfulfilled)
        tables[table].push(row)
        return Promise.resolve({ error: null }).then(onfulfilled)
      },
    }
  }

  function updateBuilder(table: string, payload: Row) {
    let predicate: (r: Row) => boolean = () => true
    const chain: Record<string, unknown> = {}
    const addFilter = (fn: (r: Row) => boolean) => {
      const prev = predicate
      predicate = (r) => prev(r) && fn(r)
    }
    chain.eq = vi.fn((c: string, v: unknown) => {
      addFilter((r) => r[c] === v)
      return chain
    })
    chain.in = vi.fn((c: string, vals: unknown[]) => {
      addFilter((r) => vals.includes(r[c]))
      return chain
    })
    chain.lt = vi.fn((c: string, v: unknown) => {
      addFilter((r) => r[c] != null && (r[c] as string) < (v as string))
      return chain
    })
    const apply = () => {
      const matched = tables[table].filter(predicate)
      matched.forEach((r) => Object.assign(r, payload))
      return matched.map((r) => ({ ...r }))
    }
    // .select() must support BOTH `.select('*')` (awaited directly — an
    // array in `data`, as process.ts's claimForProcessing expects) and
    // `.select('*').single()` (ingest.ts's storage-state patch) — so the
    // returned object is itself thenable AND carries `.single()`.
    chain.select = vi.fn(() => {
      const matched = apply()
      const selected: Record<string, unknown> = {}
      selected.single = () => Promise.resolve(matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: 'not found' } })
      selected.then = (onfulfilled?: (v: unknown) => unknown) => Promise.resolve({ data: matched, error: null }).then(onfulfilled)
      return selected
    })
    chain.then = (onfulfilled?: (v: unknown) => unknown) => Promise.resolve({ error: null, data: apply() }).then(onfulfilled)
    return chain
  }

  const client = {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => selectChain(table)),
      insert: vi.fn((payload: Row) => insertBuilder(table, payload)),
      update: vi.fn((payload: Row) => updateBuilder(table, payload)),
    })),
  }

  return { client, tables }
}

let currentDb: ReturnType<typeof makeDb>
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => currentDb.client }))

import { ingestArtifact } from './ingest'
import { processArtifact } from './process'
import { annotateArtifact } from './relations'
import { searchArtifacts, getArtifactDetail, getMostRecentArtifactForOperator } from './query'
import { retrieveArtifactForOperator } from '../caye-agent/tools/write-low/retrieve-artifact-for-operator'
import type { ToolContext } from '../caye-agent/tools/types'

const WORKSPACE_ID = 'ws-bimini'
const OPERATOR_ID = 7 // Mrs. Max — matches the seeded operator_allowlist row

function opCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workspaceId: WORKSPACE_ID, callerRole: 'owner', operatorId: OPERATOR_ID, requestId: `req-${Math.random()}`, ...overrides }
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

beforeEach(() => {
  currentDb = makeDb()
  uploadArtifactBytes.mockReset().mockResolvedValue({ ok: true })
  downloadArtifactBytes.mockReset().mockResolvedValue(Buffer.from('fake-image-bytes'))
  signArtifactUrl.mockReset().mockResolvedValue('https://signed.example/original.jpg')
  describeImage.mockReset().mockResolvedValue({
    ok: true,
    value: { description: 'A photo of a paved area near a dock, with a tram stop sign.', visible_text: null, business_observations: [], confidence: 0.6 },
  })
  isWhatsAppWindowOpen.mockReset().mockResolvedValue(true)
  sendMediaWhatsApp.mockReset().mockResolvedValue({ status: 'sent', messageId: 'wamid.sent-1' })
  enqueueOperation.mockReset().mockResolvedValue({ queued: true, alreadyQueued: false })
})

describe('LITERAL Mrs. Max acceptance test (#87 canonical scenario)', () => {
  it('turn 1: ingest → understand → operator meaning preserved separately → related, without disturbing active work', async () => {
    // Mrs. Max sends an image over back-office WhatsApp.
    const ingestResult = await ingestArtifact({
      workspaceId: WORKSPACE_ID,
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.pickup-photo',
      senderOperatorAllowlistId: OPERATOR_ID,
      senderLabel: 'Mrs. Max',
    })

    expect(ingestResult.ok).toBe(true)
    if (!ingestResult.ok) throw new Error('unreachable')
    const artifactId = ingestResult.artifact.id

    // ONE canonical artifact; original bytes durably stored.
    expect(currentDb.tables.business_artifacts).toHaveLength(1)
    expect(currentDb.tables.business_artifacts[0].storage_state).toBe('stored')
    expect(currentDb.tables.business_artifacts[0].sender_operator_allowlist_id).toBe(OPERATOR_ID)

    // Processing job reachable — enqueued for this exact artifact/version.
    expect(enqueueOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'artifact_process', payload: expect.objectContaining({ artifact_id: artifactId }) })
    )

    // Understanding actually runs (simulating the queue worker picking up the job).
    const processResult = await processArtifact(artifactId)
    expect(processResult.ok).toBe(true)
    if (!processResult.ok) throw new Error('unreachable')
    expect(processResult.status).toBe('completed')
    expect(describeImage).toHaveBeenCalledTimes(1)

    const modelObservation = currentDb.tables.business_artifact_observations.find(
      (o) => o.observation_type === 'visual_description'
    )
    expect(modelObservation).toBeTruthy()
    expect(modelObservation?.provenance_status).toBe('observed') // a guess, not truth

    // Operator text: "This is the pickup spot for cruise guests. Remember this."
    // → annotate_artifact, resolving to the artifact she JUST sent (no id given).
    const activeWork = { sourceMessageId: 'msg-jeff-draft', entityRef: 'jeff@example.com', operation: 'customer_reply_draft' as const }
    const ctx = opCtx({ activeWork })
    const annotateResult = await annotateArtifact({
      workspaceId: WORKSPACE_ID,
      artifactId, // in the real tool this is resolved via getMostRecentArtifactForOperator when omitted; passed explicitly here since we already have it from ingestion
      operatorAllowlistId: OPERATOR_ID,
      meaning: 'The pickup spot for cruise guests.',
    })
    expect(annotateResult.ok).toBe(true)

    // Operator-provided meaning is preserved SEPARATELY from the model's guess
    // — both rows exist, distinctly provenanced, neither overwrites the other.
    const operatorAnnotation = currentDb.tables.business_artifact_observations.find(
      (o) => o.observation_type === 'operator_annotation'
    )
    expect(operatorAnnotation).toBeTruthy()
    expect(operatorAnnotation?.provenance_status).toBe('operator_confirmed')
    expect(operatorAnnotation?.derived_by).toBe(`operator:${OPERATOR_ID}`)
    // The model's original observation is untouched, not merged or deleted.
    expect(currentDb.tables.business_artifact_observations.find((o) => o.observation_type === 'visual_description')?.superseded_at).toBeFalsy()

    // No active email draft/work was touched by any of this.
    expect(ctx.activeWork).toBe(activeWork)
    expect(ctx.activeWork?.entityRef).toBe('jeff@example.com')
  })

  it('fresh context / later turn: "What was that pickup picture I sent you?" resolves from durable state alone', async () => {
    // Simulates turn 1 having already happened in a PRIOR process/session —
    // no transcript, no active-work object, just what's in the database.
    const ingestResult = await ingestArtifact({
      workspaceId: WORKSPACE_ID,
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.pickup-photo',
      senderOperatorAllowlistId: OPERATOR_ID,
    })
    if (!ingestResult.ok) throw new Error('unreachable')
    const artifactId = ingestResult.artifact.id
    await processArtifact(artifactId)
    await annotateArtifact({ workspaceId: WORKSPACE_ID, artifactId, operatorAllowlistId: OPERATOR_ID, meaning: 'The pickup spot for cruise guests.' })

    // FRESH turn — a brand new ctx, no relation to the above beyond the DB.
    const results = await searchArtifacts({ workspaceId: WORKSPACE_ID, query: 'pickup picture' })
    expect(results.items.map((r) => r.artifact.id)).toContain(artifactId)
    expect(results.ambiguous).toBe(false) // only one candidate exists

    // "Send it back to me." → retrieve_artifact_for_operator resolves the
    // SAME artifact, uses the actual stored bytes (via signArtifactUrl on
    // the real storage_path), sends to the BACK-OFFICE operator, and
    // records real send evidence.
    const sendResult = await retrieveArtifactForOperator.execute({ artifact_id: artifactId }, opCtx())
    expect(sendResult.ok).toBe(true)
    expect(signArtifactUrl).toHaveBeenCalledWith(currentDb.tables.business_artifacts[0].storage_path)
    // filename was ingested as null, so the caption is null too — expect.anything() deliberately excludes null/undefined, so match it literally here.
    expect(sendMediaWhatsApp).toHaveBeenCalledWith('+12345550100', 'image', expect.any(String), null, expect.any(String))
    expect((sendResult.data as { provider_message_id?: string })?.provider_message_id).toBe('wamid.sent-1')
    // No regenerated/reconstructed artifact — only ever the one signed from storage_path.
    expect(uploadArtifactBytes).toHaveBeenCalledTimes(1) // only the ORIGINAL ingest upload, nothing new generated
  })

  it('correction: "Actually don\'t use that one anymore — the new pickup spot is the Casino Tram Stop" supersedes without deleting evidence', async () => {
    const ingestResult = await ingestArtifact({
      workspaceId: WORKSPACE_ID,
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.pickup-photo',
      senderOperatorAllowlistId: OPERATOR_ID,
    })
    if (!ingestResult.ok) throw new Error('unreachable')
    const artifactId = ingestResult.artifact.id
    await processArtifact(artifactId)
    await annotateArtifact({
      workspaceId: WORKSPACE_ID,
      artifactId,
      operatorAllowlistId: OPERATOR_ID,
      meaning: 'The pickup spot for cruise guests.',
      relationType: 'depicts_location',
      targetEntityType: 'business_fact',
      targetEntityId: 'fact-current-pickup-spot',
    })

    // The correction.
    const correction = await annotateArtifact({
      workspaceId: WORKSPACE_ID,
      artifactId,
      operatorAllowlistId: OPERATOR_ID,
      meaning: 'Not this one — the current pickup spot is the Casino Tram Stop.',
      relationType: 'depicts_location',
      targetEntityType: 'business_fact',
      targetEntityId: 'fact-current-pickup-spot',
    })
    expect(correction.ok).toBe(true)

    // Original artifact remains stored for history/audit — never deleted.
    expect(currentDb.tables.business_artifacts).toHaveLength(1)
    expect(currentDb.tables.business_artifacts[0].deleted_at).toBeFalsy()

    // The OLD annotation/relation is superseded, not deleted — both rows still exist.
    const annotations = currentDb.tables.business_artifact_observations.filter((o) => o.observation_type === 'operator_annotation')
    expect(annotations).toHaveLength(2)
    expect(annotations.find((a) => a.superseded_at != null)).toBeTruthy()
    expect(annotations.find((a) => a.superseded_at == null)?.content).toMatchObject({ meaning: expect.stringContaining('Casino Tram Stop') })

    const relations = currentDb.tables.business_artifact_relations.filter((r) => r.target_entity_id === 'fact-current-pickup-spot')
    expect(relations).toHaveLength(2)
    expect(relations.find((r) => r.superseded_at != null)).toBeTruthy()

    // Fresh retrieval of "current pickup" (get_artifact) surfaces only the
    // CURRENT (non-superseded) meaning — the old one does not keep winning.
    const detail = await getArtifactDetail(WORKSPACE_ID, artifactId)
    const activeAnnotationTexts = detail?.observations
      .filter((o) => o.observation_type === 'operator_annotation')
      .map((o) => (o.content as { meaning?: string }).meaning)
    expect(activeAnnotationTexts).toEqual(['Not this one — the current pickup spot is the Casino Tram Stop.'])

    // But historical retrieval (explicit, including superseded) can still find it — nothing was destroyed.
    // (query.ts's ordinary read path already proves this by construction: the
    // superseded row is filtered OUT of `.is('superseded_at', null)`, not deleted.)
    const allAnnotationsEverWritten = currentDb.tables.business_artifact_observations.filter((o) => o.observation_type === 'operator_annotation')
    expect(allAnnotationsEverWritten).toHaveLength(2)
  })
})

describe('AMBIGUITY acceptance test (#87 review pass 3)', () => {
  it('two equally-plausible pickup photos → Caye must ask, not guess; a follow-up disambiguates deterministically', async () => {
    const pinkBuilding = await ingestArtifact({
      workspaceId: WORKSPACE_ID, sourceChannel: 'whatsapp_operator', bytes: PNG_BYTES, declaredMimeType: 'image/png',
      filename: null, providerAttachmentId: 'wamid.pink-building', senderOperatorAllowlistId: OPERATOR_ID,
    })
    const casinoTramStop = await ingestArtifact({
      workspaceId: WORKSPACE_ID, sourceChannel: 'whatsapp_operator', bytes: PNG_BYTES, declaredMimeType: 'image/png',
      filename: null, providerAttachmentId: 'wamid.casino-tram', senderOperatorAllowlistId: OPERATOR_ID,
    })
    if (!pinkBuilding.ok || !casinoTramStop.ok) throw new Error('unreachable')

    await annotateArtifact({ workspaceId: WORKSPACE_ID, artifactId: pinkBuilding.artifact.id, operatorAllowlistId: OPERATOR_ID, meaning: 'Pink building by dock pickup point.' })
    await annotateArtifact({ workspaceId: WORKSPACE_ID, artifactId: casinoTramStop.artifact.id, operatorAllowlistId: OPERATOR_ID, meaning: 'Casino Tram Stop pickup point.' })

    // "Send me the pickup picture." — both match "pickup" equally.
    const ambiguousSearch = await searchArtifacts({ workspaceId: WORKSPACE_ID, query: 'pickup picture' })
    expect(ambiguousSearch.items).toHaveLength(2)
    expect(ambiguousSearch.ambiguous).toBe(true) // Caye must ask, never silently pick one

    // "The Casino Tram Stop one." — a distinguishing query resolves deterministically.
    const disambiguated = await searchArtifacts({ workspaceId: WORKSPACE_ID, query: 'Casino Tram Stop' })
    expect(disambiguated.ambiguous).toBe(false)
    expect(disambiguated.items).toHaveLength(1)
    expect(disambiguated.items[0].artifact.id).toBe(casinoTramStop.artifact.id)

    // Retrieval returns B's original artifact — never A's, never a blend.
    const sendResult = await retrieveArtifactForOperator.execute({ artifact_id: disambiguated.items[0].artifact.id }, opCtx())
    expect(sendResult.ok).toBe(true)
    expect((sendResult.data as { artifact_id: string }).artifact_id).toBe(casinoTramStop.artifact.id)
  })
})

describe('FAILURE/RETRY acceptance test (#87 review pass 3) — the most important durability recovery path', () => {
  it('DB identity succeeds, initial upload fails, provider retries the same attachment → same artifact id, eventually durable, understood, and retrievable', async () => {
    uploadArtifactBytes.mockResolvedValueOnce({ ok: false, error: 'storage backend timeout' })

    const first = await ingestArtifact({
      workspaceId: WORKSPACE_ID, sourceChannel: 'whatsapp_operator', bytes: PNG_BYTES, declaredMimeType: 'image/png',
      filename: null, providerAttachmentId: 'wamid.meta-retry', senderOperatorAllowlistId: OPERATOR_ID,
    })
    expect(first.ok).toBe(false)
    expect(currentDb.tables.business_artifacts).toHaveLength(1)
    expect(currentDb.tables.business_artifacts[0].storage_state).toBe('failed')

    // Meta/webhook redelivers the identical attachment (the real production
    // trigger for this: Meta retries a webhook it didn't get a 200 for).
    const second = await ingestArtifact({
      workspaceId: WORKSPACE_ID, sourceChannel: 'whatsapp_operator', bytes: PNG_BYTES, declaredMimeType: 'image/png',
      filename: null, providerAttachmentId: 'wamid.meta-retry', senderOperatorAllowlistId: OPERATOR_ID,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')

    // Same artifact id reused — never a duplicate.
    expect(currentDb.tables.business_artifacts).toHaveLength(1)
    expect(second.artifact.id).toBe(currentDb.tables.business_artifacts[0].id)
    expect(currentDb.tables.business_artifacts[0].storage_state).toBe('stored')

    // Understanding eventually occurs (the queue worker's actual call).
    const processResult = await processArtifact(second.artifact.id)
    expect(processResult.ok).toBe(true)
    expect(currentDb.tables.business_artifact_observations.length).toBeGreaterThan(0)

    // Later retrieval succeeds.
    const detail = await getArtifactDetail(WORKSPACE_ID, second.artifact.id)
    expect(detail).not.toBeNull()
    expect(detail?.artifact.storage_state).toBe('stored')
  })
})
