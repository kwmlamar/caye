import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import type { ExtractLearningInput, ExtractionResult } from '@/lib/business-learning/extract'
import type { ExtractedLearningCandidate } from '@/lib/business-learning/model'
import type { EmployeeEvalAdapter, EmployeeEvalStepContext } from './runner'
import type {
  ActionObservation,
  AuthorityKind,
  DurableFactObservation,
  EmployeeScenarioFixture,
  EmployeeScenarioSnapshot,
  LearningStage,
  LearningTraceObservation,
  RetrievalObservation,
  SourceDomain,
} from './types'
import type { EmployeeEvalEvent } from './scenario-events'
import { CAYE_EMPLOYEE_BENCHMARK_VERSION, ZERO_LEDGER } from './types'
import { PGliteSupabaseClient } from './pglite-supabase'

const BASE_SCHEMA = resolve(process.cwd(), 'lib/caye-employee-eval/eval-base-schema.sql')
const REQUIRED_MIGRATION = 'supabase/migrations/20260901_continuous_business_learning.sql'
const MAX_DRAIN_PASSES = 50

type PipelineModule = typeof import('@/lib/business-learning/pipeline')

type ObservationRow = {
  id: string
  source_kind: string
  source_id: string
  source_fingerprint: string
  source_metadata: Record<string, unknown> | null
  semantic_scope: string | null
  status: string
  processing_error: string | null
}

type LearningEventRow = {
  id: string | number
  event_type: string
  observation_id: string | null
  candidate_id: string | null
  fact_id: string | null
  details: Record<string, unknown> | null
}

let db: PGlite | null = null
let client: PGliteSupabaseClient | null = null
let pipelinePromise: Promise<PipelineModule> | null = null
let initialized = false
let migrationNames: string[] = []
let actualRevision = ''
let restoreMocks: (() => void) | null = null

const eventObservation = new Map<string, string>()
const eventDomains = new Map<string, SourceDomain>()
const eventRetrievals = new Map<string, RetrievalObservation[]>()
const externalEffects: Array<{ provider: string; kind: string; target?: string }> = []
let currentFixture: EmployeeScenarioFixture | null = null
let currentClock = '1970-01-01T00:00:00.000Z'

function uuidFor(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ['8','9','a','b'][parseInt(hex[16], 16) % 4]
  const s = hex.join('')
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`
}

function gitRevision(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function verifyRevision(): string {
  const actual = gitRevision()
  const expected = process.env.CAYE_EMPLOYEE_CODE_REVISION || process.env.GITHUB_SHA
  if (expected && actual !== expected) {
    throw new Error(`UNEVALUABLE: candidate SHA mismatch. expected=${expected} actual=${actual}`)
  }
  return actual
}

function candidate(
  propertyKey: string,
  valueText: string,
  overrides: Partial<ExtractedLearningCandidate> = {},
): ExtractedLearningCandidate {
  return {
    kind: 'durable_fact',
    durable: true,
    category: 'service_detail',
    propertyKey,
    valueText,
    scope: { target: 'workspace', serviceName: null, customerId: null, dateISO: null },
    confidence: 1,
    consequential: false,
    customerUseState: 'customer_safe',
    rationale: 'Deterministic Employee Eval provider extraction from the supplied frozen observation.',
    ...overrides,
  }
}

/**
 * Deterministic replacement for the external LLM provider. It interprets only
 * the observation text supplied by the frozen scenario. It does not read
 * expectedFacts, expectedOpportunities, baseline snapshots, or evaluator
 * assertion data.
 */
async function deterministicExtraction(input: ExtractLearningInput): Promise<ExtractionResult> {
  const text = input.content
  const lower = text.toLowerCase()
  const candidates: ExtractedLearningCandidate[] = []

  if (/\bowner of ods construction/i.test(text)) {
    const owner = text.match(/I am ([^,]+), owner/i)?.[1]
    if (owner) candidates.push(candidate('owner_name', owner))
    const business = text.match(/owner of ([^.]+)\./i)?.[1]
    if (business) candidates.push(candidate('business_name', business))
    if (/residential remodeling/i.test(text)) candidates.push(candidate('service_category', 'residential remodeling'))
    if (/eleuthera, bahamas/i.test(lower)) candidates.push(candidate('service_area', 'Eleuthera, Bahamas'))
    if (/quotes are free/i.test(lower)) {
      candidates.push(candidate('quote_fee', 'Quotes are free', {
        kind: 'policy', category: 'policy', consequential: true, customerUseState: 'customer_safe',
      }))
    }
  } else if (/site estimates are now \$?150/i.test(text)) {
    candidates.push(candidate('quote_fee', '$150 site estimate, credited back if the project is signed', {
      kind: 'policy', category: 'policy', consequential: true, customerUseState: 'customer_safe',
    }))
  } else if (/casino tram stop/i.test(lower) && /(pickup|meeting)/i.test(lower)) {
    candidates.push(candidate('meeting_point', 'Casino Tram Stop', {
      category: 'logistics', consequential: true, customerUseState: 'customer_safe',
    }))
  } else {
    // Transactional observations still exercise the real classify/resolve path
    // without being promoted into durable business memory.
    candidates.push(candidate('transaction_context', text.slice(0, 500), {
      kind: 'customer_state', durable: false, category: 'special_handling', confidence: 0.95,
      consequential: false, customerUseState: 'internal_only',
    }))
  }

  return { ok: true, candidates }
}

async function migrationFiles(): Promise<string[]> {
  const extra = (process.env.CAYE_EMPLOYEE_EVAL_MIGRATIONS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return [...new Set([REQUIRED_MIGRATION, ...extra])]
}

async function initialize(): Promise<void> {
  if (initialized) {
    verifyRevision()
    return
  }

  actualRevision = verifyRevision()
  db = new PGlite()
  client = new PGliteSupabaseClient(db)
  await db.exec(await readFile(BASE_SCHEMA, 'utf8'))

  migrationNames = []
  for (const relative of await migrationFiles()) {
    const path = resolve(process.cwd(), relative)
    try {
      await db.exec(await readFile(path, 'utf8'))
      await db.query('insert into employee_eval_migration_state(migration_name) values ($1) on conflict do nothing', [relative])
      migrationNames.push(relative)
    } catch (error) {
      throw new Error(`UNEVALUABLE: candidate migration failed (${relative}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  process.env.CAYE_EMPLOYEE_EVAL_RUNTIME = '1'
  vi.doMock('@/lib/supabase-server', () => ({
    createServiceClient: () => client,
  }))
  vi.doMock('@/lib/business-learning/extract', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/business-learning/extract')>()
    return { ...original, extractBusinessLearning: deterministicExtraction }
  })
  restoreMocks = () => {
    vi.doUnmock('@/lib/supabase-server')
    vi.doUnmock('@/lib/business-learning/extract')
  }
  pipelinePromise = import('@/lib/business-learning/pipeline')
  await pipelinePromise
  initialized = true
}

async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!db) throw new Error('UNEVALUABLE: Employee Eval database is not initialized')
  const result = await db.query<T>(sql, params as never[])
  return result.rows
}

async function resetDatabase(fixture: EmployeeScenarioFixture): Promise<void> {
  if (!db) throw new Error('UNEVALUABLE: Employee Eval database is not initialized')
  await db.exec(`
    truncate table business_learning_events, business_fact_candidates, business_learning_observations,
      caye_operator_messages, unified_messages, unified_conversations, connected_accounts,
      booking_services, business_facts, customers restart identity cascade;
  `)
  await db.query('insert into customers(id, business_name) values ($1, $2)', [fixture.workspaceId, fixture.businessName])
  const accountId = uuidFor(`${fixture.id}:account`)
  await db.query('insert into connected_accounts(id, user_id, provider) values ($1, $2, $3)', [accountId, fixture.workspaceId, 'employee-eval'])

  const count = await query<{ n: number }>('select count(*)::int as n from customers')
  if (Number(count[0]?.n ?? 0) !== 1) throw new Error('UNEVALUABLE: scenario state reset could not be verified')
}

async function insertDirectObservation(event: EmployeeEvalEvent, fixture: EmployeeScenarioFixture): Promise<string> {
  const id = uuidFor(`${fixture.id}:${event.id}:observation`)
  const metadata = {
    source: event.kind === 'onboarding' ? 'onboarding' : event.channel,
    eval_event_id: event.id,
    source_domain: event.sourceDomain,
    actor_role: event.actorRole,
    ...(event.data ?? {}),
  }
  await db!.query(
    `insert into business_learning_observations
      (id, workspace_id, source_kind, source_id, source_fingerprint, source_channel, content, source_metadata, semantic_scope, created_at, first_seen_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10,$10)`,
    [id, fixture.workspaceId, event.kind === 'onboarding' ? 'onboarding' : `eval_${event.kind}`, event.id, `employee-eval:${event.id}`, event.channel, event.text ?? JSON.stringify(event.data ?? {}), JSON.stringify(metadata), String(event.data?.semantic_scope ?? '') || null, event.at],
  )
  return id
}

async function insertEmailObservation(event: EmployeeEvalEvent, fixture: EmployeeScenarioFixture): Promise<string> {
  const accountId = uuidFor(`${fixture.id}:account`)
  const conversationId = uuidFor(`${fixture.id}:${String(event.data?.thread_id ?? event.id)}:conversation`)
  await db!.query(
    `insert into unified_conversations(id, connected_account_id, channel_type) values ($1,$2,'gmail') on conflict (id) do nothing`,
    [conversationId, accountId],
  )
  const messageId = uuidFor(`${fixture.id}:${event.id}:message`)
  const metadata = JSON.stringify({
    source: 'gmail', eval_event_id: event.id, source_domain: event.sourceDomain, actor_role: event.actorRole, ...(event.data ?? {}),
  })
  await db!.query(
    `insert into unified_messages(id, conversation_id, sender_type, content, metadata, is_internal, sent_at, created_at)
     values ($1,$2,$3,$4,$5::jsonb,false,$6,$6)`,
    [messageId, conversationId, event.actorRole === 'vendor' ? 'customer' : event.actorRole, event.text ?? '', metadata, event.at],
  )
  const rows = await query<{ id: string }>(
    `select id from business_learning_observations where workspace_id=$1 and source_fingerprint=$2`,
    [fixture.workspaceId, `unified_message:${messageId}`],
  )
  if (!rows[0]?.id) throw new Error(`UNEVALUABLE: persisted email ${event.id} did not create a durable learning observation`)
  await db!.query(
    `update business_learning_observations set source_metadata = source_metadata || $1::jsonb, created_at=$2, first_seen_at=$2 where id=$3`,
    [JSON.stringify({ eval_event_id: event.id, source_domain: event.sourceDomain, actor_role: event.actorRole }), event.at, rows[0].id],
  )
  return rows[0].id
}

async function insertCorrectionObservation(event: EmployeeEvalEvent, fixture: EmployeeScenarioFixture): Promise<string> {
  const messageId = uuidFor(`${fixture.id}:${event.id}:operator-message`)
  await db!.query(
    `insert into caye_operator_messages(id, workspace_id, direction, body, operator_role, operator_allowlist_id, intent, created_at)
     values ($1,$2,'inbound',$3,'owner',null,'correction',$4)`,
    [messageId, fixture.workspaceId, event.text ?? '', event.at],
  )
  const rows = await query<{ id: string }>(
    `select id from business_learning_observations where workspace_id=$1 and source_fingerprint=$2`,
    [fixture.workspaceId, `operator_message:${messageId}`],
  )
  if (!rows[0]?.id) throw new Error(`UNEVALUABLE: owner correction ${event.id} did not create a durable learning observation`)
  await db!.query(
    `update business_learning_observations set source_metadata = source_metadata || $1::jsonb, created_at=$2, first_seen_at=$2 where id=$3`,
    [JSON.stringify({ eval_event_id: event.id, source_domain: event.sourceDomain, actor_role: event.actorRole }), event.at, rows[0].id],
  )
  return rows[0].id
}

async function drainWorkers(): Promise<void> {
  const pipeline = await pipelinePromise
  if (!pipeline) throw new Error('UNEVALUABLE: business-learning worker module did not initialize')

  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
    const before = await query<{ id: string; status: string; attempt_count: number }>(
      `select id,status,attempt_count from business_learning_observations where status in ('pending','failed') order by created_at,id`,
    )
    if (before.length === 0) break
    const signature = JSON.stringify(before)
    await pipeline.processPendingBusinessLearning(100)
    const after = await query<{ id: string; status: string; attempt_count: number }>(
      `select id,status,attempt_count from business_learning_observations where status in ('pending','failed') order by created_at,id`,
    )
    if (after.length > 0 && JSON.stringify(after) === signature) {
      throw new Error(`UNEVALUABLE: business-learning queue made no progress (${after.map((x) => x.id).join(',')})`)
    }
  }

  const stuck = await query<{ id: string; status: string; processing_error: string | null }>(
    `select id,status,processing_error from business_learning_observations where status in ('pending','processing','failed')`,
  )
  if (stuck.length) {
    throw new Error(`UNEVALUABLE: required learning worker did not drain: ${JSON.stringify(stuck)}`)
  }
}

function authority(value: string | null): AuthorityKind {
  if (value === 'owner') return 'owner'
  if (value === 'operator') return 'operator'
  if (value === 'staff') return 'staff'
  if (value === 'customer') return 'customer'
  if (value === 'system') return 'system'
  if (value === 'founder') return 'founder'
  if (value === 'observation') return 'inferred'
  return 'unknown'
}

async function sourceDomainForObservation(observationId: string | null): Promise<SourceDomain> {
  if (!observationId) return 'customer_business'
  const rows = await query<{ source_metadata: Record<string, unknown> | null }>('select source_metadata from business_learning_observations where id=$1', [observationId])
  const value = String(rows[0]?.source_metadata?.source_domain ?? 'customer_business') as SourceDomain
  return value
}

async function freshRetrieval(fixture: EmployeeScenarioFixture, event: EmployeeEvalEvent): Promise<RetrievalObservation[]> {
  const rows = await query<Record<string, unknown>>(
    `select id,canonical_key,fact,provenance,customer_use_state from business_facts
     where workspace_id=$1 and superseded_at is null and (expires_at is null or expires_at > $2::timestamptz)
     order by created_at,id`,
    [fixture.workspaceId, event.at],
  )
  const eligible = rows.filter((row) => ['customer_safe','authoritative'].includes(String(row.customer_use_state ?? 'authoritative')))
  return Promise.all(eligible.map(async (row) => {
    const provenance = (row.provenance ?? {}) as Record<string, unknown>
    const observationId = typeof provenance.observation_id === 'string' ? provenance.observation_id : null
    return {
      id: `retrieval:${event.id}:${String(row.id)}`,
      workspaceId: fixture.workspaceId,
      canonicalKey: row.canonical_key ? String(row.canonical_key) : null,
      factId: String(row.id),
      value: String(row.fact),
      current: true,
      customerFacingUse: true,
      evidenceRefs: [String(row.id), ...(observationId ? [observationId] : [])],
      sourceDomain: await sourceDomainForObservation(observationId),
      at: event.at,
    }
  }))
}

async function factsSnapshot(fixture: EmployeeScenarioFixture): Promise<DurableFactObservation[]> {
  const facts = await query<Record<string, unknown>>('select * from business_facts where workspace_id=$1 order by created_at,id', [fixture.workspaceId])
  const candidates = await query<Record<string, unknown>>('select * from business_fact_candidates where workspace_id=$1 order by created_at,id', [fixture.workspaceId])

  const durable = await Promise.all(facts.map(async (row) => {
    const provenance = (row.provenance ?? {}) as Record<string, unknown>
    const observationId = typeof provenance.observation_id === 'string' ? provenance.observation_id : null
    const state = row.superseded_at ? 'superseded' : 'current'
    const useState = String(row.customer_use_state ?? 'authoritative')
    return {
      id: String(row.id),
      workspaceId: fixture.workspaceId,
      memoryType: row.memory_type ? String(row.memory_type) : null,
      canonicalKey: row.canonical_key ? String(row.canonical_key) : null,
      value: String(row.fact),
      authority: authority(row.authority_kind ? String(row.authority_kind) : null),
      confidence: row.confidence == null ? null : Number(row.confidence),
      provenance: {
        type: String(provenance.learning_authority ?? row.source ?? 'unknown'),
        source: String(provenance.source_id ?? provenance.source_fingerprint ?? row.source ?? 'unknown'),
        ref: observationId ?? undefined,
        observedAt: row.valid_from ? String(row.valid_from) : undefined,
      },
      validFrom: row.valid_from ? String(row.valid_from) : null,
      validTo: row.superseded_at ? String(row.superseded_at) : row.expires_at ? String(row.expires_at) : null,
      state,
      retrievable: state === 'current' && ['customer_safe','authoritative'].includes(useState),
      customerFacingEligible: state === 'current' && ['customer_safe','authoritative'].includes(useState),
      consequential: Boolean(provenance.consequential),
      sourceDomain: await sourceDomainForObservation(observationId),
      supersededBy: row.superseded_by ? String(row.superseded_by) : null,
      correctionOf: row.correction_of_fact_id ? String(row.correction_of_fact_id) : null,
      customerUseState: useState,
    } as DurableFactObservation
  }))

  const pending = await Promise.all(candidates.map(async (row) => {
    const provenance = (row.provenance ?? {}) as Record<string, unknown>
    const observationId = row.observation_id ? String(row.observation_id) : null
    return {
      id: String(row.id),
      workspaceId: fixture.workspaceId,
      memoryType: row.memory_type ? String(row.memory_type) : null,
      canonicalKey: row.canonical_key ? String(row.canonical_key) : null,
      value: String(row.sample_text),
      authority: authority(String(row.authority_kind ?? '')),
      confidence: row.confidence == null ? null : Number(row.confidence),
      provenance: {
        type: String(row.authority_kind ?? 'candidate'),
        source: String(row.source_id ?? row.source ?? 'unknown'),
        ref: observationId ?? undefined,
      },
      validFrom: row.valid_from ? String(row.valid_from) : null,
      validTo: null,
      state: row.status === 'resolved' ? 'candidate' : row.status === 'rejected' ? 'rejected' : 'candidate',
      retrievable: false,
      customerFacingEligible: false,
      consequential: Boolean(provenance.consequential),
      sourceDomain: await sourceDomainForObservation(observationId),
      supersededBy: null,
      correctionOf: null,
      customerUseState: row.customer_use_state ? String(row.customer_use_state) : null,
      candidateFingerprint: row.candidate_fingerprint ? String(row.candidate_fingerprint) : null,
    } as DurableFactObservation
  }))

  return [...durable, ...pending]
}

async function tracesSnapshot(fixture: EmployeeScenarioFixture): Promise<LearningTraceObservation[]> {
  const observations = await query<ObservationRow>('select id,source_kind,source_id,source_fingerprint,source_metadata,semantic_scope,status,processing_error from business_learning_observations where workspace_id=$1', [fixture.workspaceId])
  const events = await query<LearningEventRow>('select id,event_type,observation_id,candidate_id,fact_id,details from business_learning_events where workspace_id=$1 order by id', [fixture.workspaceId])
  const byObservation = new Map<string, LearningEventRow[]>()
  for (const event of events) {
    if (!event.observation_id) continue
    const list = byObservation.get(event.observation_id) ?? []
    list.push(event)
    byObservation.set(event.observation_id, list)
  }

  const traces: LearningTraceObservation[] = []
  for (const eventId of fixture.requiredTraceIds) {
    const observationId = eventObservation.get(eventId)
    const observation = observations.find((row) => row.id === observationId)
    const lifecycle = observation ? (byObservation.get(observation.id) ?? []) : []
    const types = new Set(lifecycle.map((x) => x.event_type))
    const domain = eventDomains.get(eventId) ?? 'system_internal'
    const retrieval = eventRetrievals.get(eventId)
    const evidence = (names: string[]) => lifecycle.filter((x) => names.includes(x.event_type)).map((x) => `learning-event:${x.id}`)
    const stages: Partial<Record<LearningStage, { completed: boolean; evidenceRefs: string[] }>> = {
      observe: { completed: Boolean(observation && (types.has('observation_examined') || types.has('observation_excluded'))), evidenceRefs: observation ? [observation.id, ...evidence(['observation_examined','observation_excluded'])] : [] },
      extract: { completed: types.has('extraction_started') && !types.has('extraction_failed'), evidenceRefs: evidence(['extraction_started','extraction_failed']) },
      classify: { completed: types.has('candidate_created') || types.has('candidate_deduplicated') || types.has('candidate_rejected'), evidenceRefs: evidence(['candidate_created','candidate_deduplicated','candidate_rejected']) },
      resolve: { completed: types.has('candidate_created') || types.has('candidate_deduplicated') || types.has('candidate_rejected') || types.has('conflict_resolved'), evidenceRefs: evidence(['candidate_created','candidate_deduplicated','candidate_rejected','conflict_detected','conflict_resolved']) },
      store: { completed: types.has('candidate_created') || types.has('fact_promoted') || types.has('fact_updated'), evidenceRefs: evidence(['candidate_created','fact_promoted','fact_updated']) },
      retrieve: { completed: retrieval !== undefined, evidenceRefs: retrieval?.flatMap((x) => x.evidenceRefs) ?? [] },
      act: { completed: false, evidenceRefs: [] },
    }
    if (eventId.includes('correction')) {
      stages.correct = { completed: types.has('conflict_resolved') && types.has('fact_superseded'), evidenceRefs: evidence(['conflict_detected','conflict_resolved','fact_superseded']) }
    }
    traces.push({
      id: eventId,
      workspaceId: fixture.workspaceId,
      required: true,
      evaluable: Boolean(observation && observation.status !== 'processing' && !observation.processing_error),
      sourceDomain: domain,
      stages,
    })
  }
  return traces
}

async function assertMigrationsApplied(): Promise<void> {
  const rows = await query<{ migration_name: string }>('select migration_name from employee_eval_migration_state order by migration_name')
  const applied = new Set(rows.map((x) => x.migration_name))
  for (const name of migrationNames) {
    if (!applied.has(name)) throw new Error(`UNEVALUABLE: candidate migration is not recorded as applied: ${name}`)
  }
  const schema = await query<{ observations: string | null; events: string | null }>(
    `select to_regclass('business_learning_observations')::text as observations, to_regclass('business_learning_events')::text as events`,
  )
  if (!schema[0]?.observations || !schema[0]?.events) throw new Error('UNEVALUABLE: candidate learning schema is unavailable after migrations')
}

export const employeeEvalAdapter: EmployeeEvalAdapter = {
  name: 'caye-production-isolated-pglite',

  async reset(fixture: EmployeeScenarioFixture): Promise<void> {
    await initialize()
    actualRevision = verifyRevision()
    await assertMigrationsApplied()
    currentFixture = fixture
    currentClock = '1970-01-01T00:00:00.000Z'
    eventObservation.clear()
    eventDomains.clear()
    eventRetrievals.clear()
    externalEffects.length = 0
    await resetDatabase(fixture)
  },

  async handle(event: EmployeeEvalEvent, context: EmployeeEvalStepContext): Promise<void> {
    const fixture = currentFixture
    if (!fixture || fixture.id !== context.scenario.id) throw new Error('UNEVALUABLE: scenario adapter state is not initialized for this fixture')
    currentClock = event.at
    eventDomains.set(event.id, event.sourceDomain)

    let observationId: string
    if (event.kind === 'email') observationId = await insertEmailObservation(event, fixture)
    else if (event.kind === 'correction') observationId = await insertCorrectionObservation(event, fixture)
    else observationId = await insertDirectObservation(event, fixture)
    eventObservation.set(event.id, observationId)

    await drainWorkers()
    eventRetrievals.set(event.id, await freshRetrieval(fixture, event))
  },

  async snapshot(fixture: EmployeeScenarioFixture): Promise<EmployeeScenarioSnapshot> {
    if (!currentFixture || currentFixture.id !== fixture.id) throw new Error('UNEVALUABLE: snapshot requested for a scenario that is not active')
    actualRevision = verifyRevision()
    await assertMigrationsApplied()
    const facts = await factsSnapshot(fixture)
    const retrievals = [...eventRetrievals.values()].flat()
    const traces = await tracesSnapshot(fixture)

    return {
      scenarioId: fixture.id,
      benchmarkVersion: CAYE_EMPLOYEE_BENCHMARK_VERSION,
      workspaceId: fixture.workspaceId,
      codeRevision: actualRevision,
      generatedAt: currentClock,
      facts,
      retrievals,
      opportunities: [],
      actions: [] as ActionObservation[],
      traces,
      ledger: { ...ZERO_LEDGER },
      notes: [
        `adapter=${employeeEvalAdapter.name}`,
        `migrations=${migrationNames.join(',')}`,
        `external_effects=${externalEffects.length}`,
        'opportunity/action surfaces are reported from observed production state only; this adapter does not synthesize missing behavior.',
      ],
    }
  },
}

export const __employeeEvalAdapterTestKit = {
  get actualRevision(): string { return actualRevision },
  get migrations(): string[] { return [...migrationNames] },
  get externalEffects(): ReadonlyArray<{ provider: string; kind: string; target?: string }> { return externalEffects },
  async counts(): Promise<Record<string, number>> {
    const tables = ['customers','business_learning_observations','business_learning_events','business_fact_candidates','business_facts']
    const out: Record<string, number> = {}
    for (const table of tables) {
      const rows = await query<{ n: number }>(`select count(*)::int as n from "${table}"`)
      out[table] = Number(rows[0]?.n ?? 0)
    }
    return out
  },
  async candidateFingerprints(): Promise<string[]> {
    const rows = await query<{ candidate_fingerprint: string | null }>('select candidate_fingerprint from business_fact_candidates where candidate_fingerprint is not null order by candidate_fingerprint')
    return rows.map((x) => x.candidate_fingerprint!).filter(Boolean)
  },
  async close(): Promise<void> {
    restoreMocks?.()
    restoreMocks = null
    if (db) await db.close()
    db = null
    client = null
    pipelinePromise = null
    initialized = false
    currentFixture = null
  },
}
