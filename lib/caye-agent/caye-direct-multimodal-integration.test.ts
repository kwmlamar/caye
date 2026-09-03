import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

vi.mock('server-only', () => ({}))

/**
 * Full-stack integration test for the multimodal Caye Direct follow-up
 * (#87), written in direct response to an adversarial review of the first
 * pass at this PR. That review's main charge: prove the actual chain —
 * search resolves a WhatsApp-ingested artifact, retrieval never sends
 * WhatsApp media on Direct, the assistant turn and its artifact reference
 * are genuinely PERSISTED (not just returned in-memory), a fresh read of
 * that persisted state still renders the artifact, and the signed URL is
 * minted only after independent server-side re-authorization — rather than
 * mocking away every boundary that would actually prove it.
 *
 * Mirrors investigation-integration.test.ts's infrastructure exactly (an
 * in-memory fake Supabase real code reads/writes against, a scripted
 * Anthropic-API-boundary "model") but goes one step further: thread
 * bookkeeping (lib/caye-direct-threads.ts) and message persistence
 * (lib/caye-operator-messages.ts) are NOT mocked here — they run for real
 * against the fake tables, so "the message is durable and reloadable" is
 * something this test actually exercises, not something it assumes.
 */

// ---- In-memory fake Supabase, generic enough for every table this chain
// touches (business_artifacts/observations/relations, operator_allowlist,
// caye_operator_messages, caye_direct_threads(_messages/_entities),
// caye_tool_calls, caye_pending_operations). ----------------------------
interface FakeRow {
  [key: string]: unknown
}
const tables = vi.hoisted(() => new Map<string, FakeRow[]>())
function table(name: string): FakeRow[] {
  if (!tables.has(name)) tables.set(name, [])
  return tables.get(name)!
}
const idCounter = vi.hoisted(() => ({ n: 0 }))

type Predicate = (r: FakeRow) => boolean

function makeQueryBuilder(rows: FakeRow[]) {
  const filters: Predicate[] = []
  let orderCol: string | null = null
  let orderAsc = true
  let limitN: number | null = null

  function resolved(): FakeRow[] {
    let out = rows.filter((r) => filters.every((f) => f(r)))
    if (orderCol) {
      const col = orderCol
      out = [...out].sort((a, b) => {
        const av = a[col] as string | number
        const bv = b[col] as string | number
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        return orderAsc ? cmp : -cmp
      })
    }
    if (limitN != null) out = out.slice(0, limitN)
    return out
  }

  const builder = {
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val)
      return builder
    },
    neq(col: string, val: unknown) {
      filters.push((r) => r[col] !== val)
      return builder
    },
    is(col: string, val: unknown) {
      filters.push((r) => (val === null ? r[col] == null : r[col] === val))
      return builder
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]))
      return builder
    },
    /** Loosely-typed negation, sufficient for the unrelated collaborators
     * (e.g. lib/outreach-operational-status.ts) this turn's system-prompt
     * assembly happens to also query — not a filter this test's fixtures
     * actually rely on being precise. */
    not(_col: string, _op: string, _val: unknown) {
      return builder
    },
    gte(col: string, val: unknown) {
      filters.push((r) => (r[col] as string) >= (val as string))
      return builder
    },
    lte(col: string, val: unknown) {
      filters.push((r) => (r[col] as string) <= (val as string))
      return builder
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderCol = col
      orderAsc = opts?.ascending !== false
      return builder
    },
    limit(n: number) {
      limitN = n
      return builder
    },
    maybeSingle() {
      return Promise.resolve({ data: resolved()[0] ?? null, error: null })
    },
    single() {
      const r = resolved()[0]
      return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'not found' } })
    },
    select() {
      return builder
    },
    then(onfulfilled?: (v: { data: FakeRow[]; error: null; count: number }) => unknown, onrejected?: (e: unknown) => unknown) {
      const data = resolved()
      return Promise.resolve({ data, error: null, count: data.length }).then(onfulfilled, onrejected)
    },
  }
  return builder
}

// Column defaults the real migration applies server-side (20260826j) that
// ingest.ts deliberately relies on rather than setting explicitly — a fake
// insert() that only ever echoes back what the caller passed would silently
// diverge from real Postgres behavior here (e.g. retention_status is never
// set by ingest.ts at all, since the schema default is 'active').
const TABLE_DEFAULTS: Record<string, FakeRow> = {
  business_artifacts: { retention_status: 'active', processing_status: 'pending', processing_version: 1 },
}

const fakeSupabase = {
  from(name: string) {
    const rows = table(name)
    return {
      select() {
        return makeQueryBuilder(rows)
      },
      insert(row: FakeRow | FakeRow[]) {
        const items = Array.isArray(row) ? row : [row]
        const inserted = items.map((r) => {
          const withId = { id: `${name}-${++idCounter.n}`, created_at: new Date().toISOString(), ...(TABLE_DEFAULTS[name] ?? {}), ...r }
          rows.push(withId)
          return withId
        })
        const single = inserted[0]
        return {
          select() {
            return {
              single: () => Promise.resolve({ data: single, error: null }),
              maybeSingle: () => Promise.resolve({ data: single ?? null, error: null }),
            }
          },
          then(onfulfilled?: (v: { data: FakeRow[]; error: null }) => unknown, onrejected?: (e: unknown) => unknown) {
            return Promise.resolve({ data: inserted, error: null }).then(onfulfilled, onrejected)
          },
        }
      },
      update(patch: FakeRow) {
        const b = makeQueryBuilder(rows)
        const apply = () => {
          for (const r of rows.filter((row) => (b as unknown as { __filters?: Predicate[] }).__filters?.every((f) => f(row)) ?? true)) {
            Object.assign(r, patch)
          }
        }
        // Reuse the same filter-collection machinery as select() by
        // wrapping the builder's eq/neq so update()'s eventual .eq() calls
        // narrow what gets patched, exactly like a real client.
        const filters: Predicate[] = []
        const chain = {
          eq(col: string, val: unknown) {
            filters.push((r) => r[col] === val)
            return chain
          },
          // Repository audit, 2026-09-03: lib/caye-direct-runs.ts (wrapped
          // around every non-voice runFounderThreadTurn call, including
          // the failure path this file's own scripted-error tests exercise
          // via failDirectRun) chains update().eq('id', runId).in('status',
          // [...]) — this update() chain only ever implemented eq(), so a
          // real production failure being handled by failDirectRun then
          // hit a second, unrelated TypeError from this fake instead of
          // completing cleanly.
          in(col: string, vals: unknown[]) {
            filters.push((r) => vals.includes(r[col]))
            return chain
          },
          select() {
            return {
              single: () => {
                for (const r of rows.filter((row) => filters.every((f) => f(row)))) Object.assign(r, patch)
                const updated = rows.find((row) => filters.every((f) => f(row)))
                return Promise.resolve({ data: updated ?? null, error: null })
              },
              maybeSingle: () => {
                for (const r of rows.filter((row) => filters.every((f) => f(row)))) Object.assign(r, patch)
                const updated = rows.find((row) => filters.every((f) => f(row)))
                return Promise.resolve({ data: updated ?? null, error: null })
              },
            }
          },
          then(onfulfilled?: (v: { data: null; error: null }) => unknown, onrejected?: (e: unknown) => unknown) {
            for (const r of rows.filter((row) => filters.every((f) => f(row)))) Object.assign(r, patch)
            return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected)
          },
        }
        void apply
        return chain
      },
      upsert(row: FakeRow, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        const keys = (opts?.onConflict ?? 'id').split(',')
        const exists = rows.some((r) => keys.every((k) => r[k] === row[k]))
        if (!exists) rows.push({ id: `${name}-${++idCounter.n}`, ...row })
        return Promise.resolve({ error: null })
      },
      delete() {
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }
  },
  storage: {
    from() {
      return {
        upload: () => Promise.resolve({ error: null }),
        // objectExists() lists the target dir and checks for an exact
        // filename match — echo back whatever it searched for, faithful
        // to "we just uploaded it, so it's there" without hardcoding an
        // image-shaped filename that would fail for a PDF's original.pdf.
        list: (_dir: string, opts?: { search?: string }) => Promise.resolve({ data: opts?.search ? [{ name: opts.search }] : [], error: null }),
        download: () => Promise.resolve({ data: null, error: { message: 'not used — mocked at the storage.ts boundary instead' } }),
        createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://signed.example/should-not-be-called-directly' }, error: null }),
      }
    },
  },
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => fakeSupabase,
  createServerClient: () => fakeSupabase,
}))

// ---- Collaborators deliberately mocked (not under test here) -----------
vi.mock('@/lib/caye-direct-threads-summarize', () => ({
  maybeGenerateThreadTitle: async () => {},
  maybeRefreshThreadSummary: async () => {},
}))
vi.mock('@/lib/operator-identity', () => ({
  resolveFounderOperator: async () => ({ id: 7, name: 'Lamar', role: 'founder' }),
}))
vi.mock('@/lib/owner-attention', () => ({ loadAttentionDelta: async () => ({}), renderAttentionContext: () => '' }))
vi.mock('@/lib/owner-attention-sync', () => ({ syncOwnerAttention: async () => {} }))
vi.mock('@/lib/model-router/caye-direct-bridge', () => ({
  runCayeDirectRouterTurn: async () => {
    throw new Error('router path must not be used in this test')
  },
}))
vi.mock('./modes/back-office', () => ({ buildBackOfficeSystemPrompt: () => 'back-office system prompt' }))

const isWhatsAppWindowOpen = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('@/lib/whatsapp/window', () => ({ isWhatsAppWindowOpen }))
const sendMediaWhatsApp = vi.hoisted(() => vi.fn().mockResolvedValue({ status: 'sent', messageId: 'wamid.test' }))
vi.mock('@/lib/whatsapp/outbound', () => ({ sendMediaWhatsApp }))
const signArtifactUrl = vi.hoisted(() => vi.fn().mockResolvedValue('https://signed.example/artifact.jpg?token=abc'))
const downloadArtifactBytes = vi.hoisted(() => vi.fn())
vi.mock('@/lib/artifacts/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/artifacts/storage')>()
  return { ...actual, signArtifactUrl, downloadArtifactBytes }
})
const enqueueOperation = vi.hoisted(() => vi.fn().mockResolvedValue({ queued: true, alreadyQueued: false }))
vi.mock('@/lib/pending-operations', () => ({ enqueueOperation }))
const processArtifact = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, status: 'completed', skipped: false }))
vi.mock('@/lib/artifacts/process', () => ({ processArtifact }))

// ---- REAL tool registry entries under test — not reimplemented fakes ---
// search_artifacts/get_artifact are imported dynamically inside the mock
// factory below rather than a second time at module scope, purely to avoid
// a duplicate top-level import; retrieve_artifact_for_operator is also
// called directly in some test bodies, so it keeps its normal import here.
import { retrieveArtifactForOperator } from './tools/write-low/retrieve-artifact-for-operator'
vi.mock('./tools/registry', async () => {
  const { searchArtifacts } = await import('./tools/read/search-artifacts')
  const { getArtifact } = await import('./tools/read/get-artifact')
  const { retrieveArtifactForOperator } = await import('./tools/write-low/retrieve-artifact-for-operator')
  return { TOOL_REGISTRY: [searchArtifacts, getArtifact, retrieveArtifactForOperator] }
})

// ---- Scripted model driver ------------------------------------------------
let script: (messages: Anthropic.MessageParam[]) => Anthropic.Message
vi.mock('@/lib/llm-telemetry', () => ({
  loggedMessagesCreate: async (_client: unknown, params: { messages: Anthropic.MessageParam[] }): Promise<Anthropic.Message> =>
    script(params.messages),
}))

import { runFounderThreadTurn } from './founder-thread-turn'
import { ingestArtifact } from '@/lib/artifacts/ingest'
import { GET as getThreadRoute } from '@/app/api/founder/caye-direct/threads/[id]/route'
import { GET as getBusinessArtifactRoute } from '@/app/api/founder/business-artifacts/[id]/route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/founder', () => ({ requireFounder: async () => ({ id: 'founder-uuid-1' }) }))

function textOf(msg: Anthropic.MessageParam): string {
  if (typeof msg.content === 'string') return msg.content
  return msg.content.map((b) => ('text' in b ? (b as { text?: string }).text ?? '' : '')).join(' ')
}
function toolResultsOf(msg: Anthropic.MessageParam): Array<{ tool_use_id: string; content: unknown }> {
  if (typeof msg.content === 'string') return []
  return msg.content.filter((b): b is Anthropic.ToolResultBlockParam => (b as { type?: string }).type === 'tool_result') as unknown as Array<{
    tool_use_id: string
    content: unknown
  }>
}

function makeMessage(content: unknown[], stop: Anthropic.Message['stop_reason'] = 'end_turn'): Anthropic.Message {
  return {
    id: `msg_${++idCounter.n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
    usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: stop, stop_sequence: null, content,
  } as Anthropic.Message
}

beforeEach(() => {
  tables.clear()
  idCounter.n = 0
  sendMediaWhatsApp.mockClear()
  signArtifactUrl.mockClear()
  downloadArtifactBytes.mockReset()
  // scope_kind/active_workspace_id (repository audit, 2026-09-03):
  // getThread/setThreadStatus/etc. (lib/caye-direct-threads.ts) filter by
  // .eq('scope_kind', 'founder').eq('active_workspace_id', workspaceId) —
  // a workspace-switching schema (DirectThread has no workspace_id field
  // at all; see e.g. switchDirectThreadWorkspace in that file) added after
  // this fixture was written with a plain workspace_id. getThread silently
  // (from this test's perspective — no thrown TypeError, since the fake's
  // .eq() just filters to zero matches) returned null for a real thread,
  // masked until this file's caye_direct_runs fixes above stopped an
  // earlier, unrelated TypeError from failing first.
  table('caye_direct_threads').push({
    id: 'thread-1',
    active_workspace_id: 'ws-bimini',
    scope_kind: 'founder',
    status: 'active',
    title: null,
    summary: null,
    created_by: 'founder',
  })
  table('operator_allowlist').push({ id: 7, workspace_id: 'ws-bimini', phone: '+12425550100', name: 'Lamar', role: 'founder' })
})

function req(url: string) {
  return new NextRequest(url, { headers: { Authorization: 'Bearer test-token' } })
}

describe('Regression: the Max photo — WhatsApp ingest, Direct retrieval, real persistence, real signed-URL resolution', () => {
  it('proves the full chain end to end against the REAL search/retrieve tools, REAL persistence, and a REAL later reload', async () => {
    // 1. WhatsApp-ingested artifact, exactly as ingest.ts would have left
    // it — including the confirmed relation an operator_annotation
    // conversation would have produced.
    const artifact = {
      id: 'artifact-max-1',
      workspace_id: 'ws-bimini',
      origin: 'external',
      source_channel: 'whatsapp_operator',
      modality: 'image',
      filename: null,
      detected_mime_type: 'image/jpeg',
      declared_mime_type: 'image/jpeg',
      storage_path: 'ws-bimini/artifact-max-1/original.jpg',
      storage_state: 'stored',
      retention_status: 'active',
      received_at: '2026-08-20T14:00:00Z',
      sender_operator_allowlist_id: 7,
      content_sha256: 'abc',
      processing_status: 'completed',
    }
    table('business_artifacts').push(artifact)
    table('business_artifact_observations').push({
      id: 'obs-1', artifact_id: artifact.id, workspace_id: 'ws-bimini', observation_type: 'visual_description',
      content: { description: 'Two people outdoors after a tour; one man on the left, two guests beside him.' }, superseded_at: null,
    })
    table('business_artifact_relations').push({
      id: 'rel-1', artifact_id: artifact.id, workspace_id: 'ws-bimini', relation_type: 'depicts_person',
      target_entity_type: 'contact', target_entity_id: 'contact-max', label: 'Max on the left with two guests post-tour',
      status: 'confirmed', provenance: 'operator_confirmed', superseded_at: null,
    })

    // 2. Script: round 1 searches, round 2 retrieves what search found,
    // round 3 answers WITHOUT claiming "Sent" — proving the model actually
    // saw the tool's delivery:'inline' field (the tool description's own
    // guidance), not just that grounding stripped a bad claim.
    let round = 0
    script = (messages) => {
      round++
      if (round === 1) {
        return makeMessage([{ type: 'tool_use', id: 'tu1', name: 'search_artifacts', input: { query: 'photo of max' } }], 'tool_use')
      }
      if (round === 2) {
        const lastUser = messages[messages.length - 1]
        const results = toolResultsOf(lastUser)
        const parsed = JSON.parse(results[0].content as string) as { data: { items: Array<{ artifact_id: string }> } }
        const foundId = parsed.data.items[0].artifact_id
        expect(foundId).toBe(artifact.id) // the search must have actually found OUR artifact
        return makeMessage([{ type: 'tool_use', id: 'tu2', name: 'retrieve_artifact_for_operator', input: { artifact_id: foundId } }], 'tool_use')
      }
      return makeMessage([{ type: 'text', text: 'Here it is — Max on the left with two guests post-tour.' }])
    }

    const result = await runFounderThreadTurn('ws-bimini', 'thread-1', 'send me that image of max we talked about earlier')

    // 3. Direct never performs a WhatsApp send.
    expect(sendMediaWhatsApp).not.toHaveBeenCalled()

    // 4. The reply is honest — no "Sent" claim about a channel that never sent anything.
    expect(result.replyText).not.toMatch(/\bi(?:'ve| have)?\s+sent\b/i)
    expect(result.replyText).toContain('Here it is')

    // 5. The artifact id entered the trusted rich-result path — checked
    // both on the in-memory return value AND independently below on the
    // raw persisted row, so this isn't "trust the function's own summary."
    expect(result.richResult?.blocks).toContainEqual({ type: 'business_artifact', artifactId: artifact.id })
    expect(JSON.stringify(result.richResult)).not.toMatch(/https?:\/\//) // no raw URL ever crosses into the persisted/returned payload

    // 6. PERSISTENCE, not React state: read the row directly out of the
    // fake DATABASE (never the function's return value) — this is what
    // survives a real page refresh.
    const persistedRows = table('caye_operator_messages').filter((r) => r.direction === 'outbound')
    expect(persistedRows.length).toBeGreaterThan(0)
    const lastPersisted = persistedRows[persistedRows.length - 1]
    expect(lastPersisted.rich_result).toEqual({
      version: 1,
      narrative: expect.any(String),
      blocks: expect.arrayContaining([{ type: 'business_artifact', artifactId: artifact.id }]),
    })

    // 7. RELOAD, for real: the actual GET thread route (same code the
    // browser calls after "destroy client state, reload"), reading through
    // the REAL getThread/getThreadMessages chain against the SAME fake
    // tables this turn just wrote to — not a second mock of "what the API
    // would probably return."
    const getRes = await getThreadRoute(req('http://localhost/api/founder/caye-direct/threads/thread-1?workspaceId=ws-bimini'), {
      params: Promise.resolve({ id: 'thread-1' }),
    })
    expect(getRes.status).toBe(200)
    const getJson = await getRes.json()
    const reloadedAssistantMsg = getJson.messages.find((m: { direction: string; rich_result?: unknown }) => m.direction === 'outbound' && m.rich_result)
    expect(reloadedAssistantMsg).toBeDefined()
    expect(reloadedAssistantMsg.rich_result.blocks).toContainEqual({ type: 'business_artifact', artifactId: artifact.id })

    // 8. Only NOW, on an authenticated fetch keyed off the id that
    // survived reload, does a signed URL get minted — and only after the
    // route independently re-verified workspace ownership (getArtifactDetail
    // is workspace-scoped; see its own tests for the cross-workspace case).
    const artifactRes = await getBusinessArtifactRoute(
      req(`http://localhost/api/founder/business-artifacts/${artifact.id}?workspaceId=ws-bimini`),
      { params: Promise.resolve({ id: artifact.id }) }
    )
    expect(artifactRes.status).toBe(200)
    const artifactJson = await artifactRes.json()
    expect(artifactJson.artifact.url).toBe('https://signed.example/artifact.jpg?token=abc')
    expect(JSON.stringify(artifactJson)).not.toMatch(/ws-bimini\/artifact-max-1\/original\.jpg/) // never the raw storage path
  })

  it('the reverse direction: retrieving the SAME artifact over WhatsApp (no channel override) performs a real send, unaffected', async () => {
    table('business_artifacts').push({
      id: 'artifact-max-2', workspace_id: 'ws-bimini', modality: 'image', storage_state: 'stored', retention_status: 'active',
      storage_path: 'ws-bimini/artifact-max-2/original.jpg', filename: 'max.jpg', source_channel: 'whatsapp_operator', received_at: '2026-08-20T14:00:00Z',
    })
    const detail = await import('@/lib/artifacts/query').then((m) => m.getArtifactDetail('ws-bimini', 'artifact-max-2'))
    expect(detail).not.toBeNull()

    const result = await retrieveArtifactForOperator.execute(
      { artifact_id: 'artifact-max-2' },
      { workspaceId: 'ws-bimini', callerRole: 'owner', operatorId: 7, requestId: 'req-wa-1' }
    )
    expect(result.ok).toBe(true)
    expect((result.data as { delivery?: string }).delivery).toBe('whatsapp')
    expect(sendMediaWhatsApp).toHaveBeenCalledTimes(1)
  })
})

describe('Ambiguity survives the Direct integration (retrieval AMBIGUITY, #143)', () => {
  it('two equally-plausible photos never get silently rendered — the model must be told to clarify, and no artifact ever reaches the trusted rich-result path', async () => {
    table('business_artifacts').push(
      {
        id: 'artifact-pickup-a', workspace_id: 'ws-bimini', modality: 'image', storage_state: 'stored', retention_status: 'active',
        storage_path: 'ws-bimini/artifact-pickup-a/original.jpg', filename: 'pickup-tram.jpg', source_channel: 'whatsapp_operator', received_at: '2026-08-19T09:00:00Z',
      },
      {
        id: 'artifact-pickup-b', workspace_id: 'ws-bimini', modality: 'image', storage_state: 'stored', retention_status: 'active',
        storage_path: 'ws-bimini/artifact-pickup-b/original.jpg', filename: 'pickup-pink-building.jpg', source_channel: 'whatsapp_operator', received_at: '2026-08-21T09:00:00Z',
      }
    )
    table('business_artifact_relations').push(
      { id: 'rel-a', artifact_id: 'artifact-pickup-a', workspace_id: 'ws-bimini', relation_type: 'depicts_location', target_entity_type: 'business_fact', target_entity_id: 'fact-1', label: 'pickup picture', status: 'confirmed', provenance: 'operator_confirmed', superseded_at: null },
      { id: 'rel-b', artifact_id: 'artifact-pickup-b', workspace_id: 'ws-bimini', relation_type: 'depicts_location', target_entity_type: 'business_fact', target_entity_id: 'fact-2', label: 'pickup picture', status: 'confirmed', provenance: 'operator_confirmed', superseded_at: null }
    )

    let round = 0
    script = (messages) => {
      round++
      if (round === 1) {
        return makeMessage([{ type: 'tool_use', id: 'tu1', name: 'search_artifacts', input: { query: 'pickup picture' } }], 'tool_use')
      }
      const lastUser = messages[messages.length - 1]
      const parsed = JSON.parse(toolResultsOf(lastUser)[0].content as string) as { data: { ambiguous: boolean } }
      expect(parsed.data.ambiguous).toBe(true) // the tool result must actually say so
      return makeMessage([{ type: 'text', text: 'I have two pickup photos on file — the tram stop and the pink building. Which one did you mean?' }])
    }

    const result = await runFounderThreadTurn('ws-bimini', 'thread-1', 'send me the pickup picture')

    expect(result.replyText).toMatch(/which one/i)
    expect(sendMediaWhatsApp).not.toHaveBeenCalled()
    // No artifact ever entered the trusted rendering path — the UI has
    // nothing to accidentally render as if one had been chosen.
    expect(result.richResult).toBeUndefined()
    const persisted = table('caye_operator_messages').filter((r) => r.direction === 'outbound')
    expect(persisted[persisted.length - 1]?.rich_result ?? null).toBeNull()
  })
})

describe('PDF path — real bytes reach the model, real card renders later', () => {
  it('a real PDF flows: durable artifact -> live document content block -> grounded answer -> later retrieval renders a document card via a signed URL', async () => {
    const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('Waiver terms: guests must be 12+ to ride.\n')])

    // 1. Real ingestArtifact — proves durable storage for a PDF specifically,
    // not just images.
    const ingestResult = await ingestArtifact({
      workspaceId: 'ws-bimini',
      sourceChannel: 'dashboard',
      bytes: pdfBytes,
      declaredMimeType: 'application/pdf',
      filename: 'waiver.pdf',
      providerAttachmentId: 'upload-key-1',
      origin: 'operator_uploaded',
      senderOperatorAllowlistId: 7,
      senderLabel: 'Lamar',
    })
    expect(ingestResult.ok).toBe(true)
    if (!ingestResult.ok) throw new Error('unreachable')
    const artifactId = ingestResult.artifact.id

    // 2. Real buildAttachmentContentBlocks — proves the PDF's actual bytes
    // (not a placeholder) reach the model as a 'document' content block.
    downloadArtifactBytes.mockResolvedValue(pdfBytes)
    const { resolveWorkspaceAttachments, buildAttachmentContentBlocks } = await import('@/lib/artifacts/attachments')
    const { resolved } = await resolveWorkspaceAttachments('ws-bimini', [artifactId])
    expect(resolved).toHaveLength(1)
    const { blocks } = await buildAttachmentContentBlocks(resolved)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } })
    const decoded = Buffer.from((blocks[0] as { source: { data: string } }).source.data, 'base64')
    expect(decoded.toString('utf8')).toContain('guests must be 12+ to ride') // the REAL bytes, not a stand-in

    // 3. Grounded answer: run a full turn with this attachment and script
    // the model to answer FROM the document block it was actually given.
    let round = 0
    script = (messages) => {
      round++
      const lastUserContent = messages[messages.length - 1].content
      const sawDocument = Array.isArray(lastUserContent) && lastUserContent.some((b) => (b as { type?: string }).type === 'document')
      if (round === 1) {
        expect(sawDocument).toBe(true)
        return makeMessage([{ type: 'text', text: "Per the waiver, guests must be 12+ to ride — I've saved the file." }])
      }
      throw new Error('should not need a second round')
    }
    const sendResult = await runFounderThreadTurn('ws-bimini', 'thread-1', 'what does this document say?', undefined, [artifactId])
    expect(sendResult.replyText).toContain('12+')

    // 4. Later retrieval renders a document card via a signed URL, same as
    // the image path — the tool call flows through retrieve_artifact_for_operator
    // exactly the same way for a document as it does for an image.
    const retrieveResult = await retrieveArtifactForOperator.execute(
      { artifact_id: artifactId },
      { workspaceId: 'ws-bimini', callerRole: 'founder', operatorId: 7, requestId: 'req-pdf-1', channel: 'dashboard' }
    )
    expect(retrieveResult.ok).toBe(true)
    expect((retrieveResult.data as { delivery?: string }).delivery).toBe('inline')

    const artifactRes = await getBusinessArtifactRoute(
      req(`http://localhost/api/founder/business-artifacts/${artifactId}?workspaceId=ws-bimini`),
      { params: Promise.resolve({ id: artifactId }) }
    )
    expect(artifactRes.status).toBe(200)
    const artifactJson = await artifactRes.json()
    expect(artifactJson.artifact.modality).toBe('document')
    expect(artifactJson.artifact.url).toBe('https://signed.example/artifact.jpg?token=abc')
  })
})
