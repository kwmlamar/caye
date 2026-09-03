import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { observeAttentionItem, type AttentionPriority } from '@/lib/owner-attention'
import { getDomainSourceConnection } from '@/lib/domain/connections'
import { isMuted, resolveAttentionOverride } from '@/lib/domain-policy'

/**
 * Domain events -> owner attention.
 *
 * THE GAP THIS CLOSES
 *
 * `ingest_external_domain_event` projects an external ledger's changes into
 * `workspace_events`, and the briefing crons compose from `loadAttentionDelta()`.
 * Nothing joined the two. Every existing `observeAttentionItem` producer is
 * driven by a conversation, an escalation, a booking or a scan — not one of
 * them reads a `domain.*` row. So a purchase order could move to `received` in
 * the source system, land correctly in `workspace_events`, and never reach the
 * owner in any briefing, ever.
 *
 * That is the same failure the whole attention ledger exists to prevent: work
 * detected correctly and then not delivered. This module is the missing wire.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not decide that a change happened — the bridge already did that, with
 * idempotency and a monotonic watermark. It does not re-read the source system;
 * the authoritative answer to "what is this now" stays with the adapter. It only
 * decides whether a change already accepted as real is worth an owner's
 * attention, and hands it to the ledger that owns notification state.
 */

/**
 * `subject_type` is free text with no CHECK constraint, and callers already use
 * ad-hoc literals ('escalation', 'booking', 'scan_finding'). A new type needs no
 * migration — but it does need to be declared once, here, so two producers
 * cannot key the same thing differently.
 */
export const SUBJECT_CONSTRUCTION_CHANGE = 'construction_change'

/** One accepted domain event, in the only shape this module needs. */
export interface DomainAttentionEvent {
  workspaceId: string
  type: string
  subjectId: string | null
  isFailure: boolean
  occurredAt: string
  payload: DomainEventPayload
}

interface DomainEventPayload {
  change_kind?: string
  observed_at?: string
  source?: {
    system?: string
    entity_type?: string
    entity_id?: string
  }
  changes?: Array<{ field: string; previous: unknown; current: unknown }>
  snapshot?: Record<string, unknown> | null
}

export interface DomainAttentionRule {
  priority: AttentionPriority
  /** What the owner is expected to do. Null when the change is purely awareness. */
  nextAction: string | null
}

/**
 * The construction domain's policy on what a change is worth.
 *
 * This is a policy table, not a heuristic, because "how loudly should this be
 * raised" is a business decision that must be reviewable in one place. Keyed by
 * the event type suffix that `lib/domain-events/normalize.ts` already produces.
 *
 * The two `decision` rows are the ones that matter most. An approved estimate
 * currently triggers nothing automatic anywhere in the business — the single
 * gap that lets work start without a signed contract. A cancelled purchase
 * order strands material money that nothing else is watching.
 */
export const CONSTRUCTION_ATTENTION_RULES: Record<string, DomainAttentionRule> = {
  'estimate.status_changed': {
    priority: 'decision',
    nextAction: 'If this was approved, issue the contract and the deposit invoice before work starts.',
  },
  'purchase_order.status_changed': {
    priority: 'awareness',
    nextAction: 'If material has landed, confirm what is on island and release anything waiting on it.',
  },
  'purchase_order.amount_changed': {
    priority: 'decision',
    nextAction: 'Check the new amount against the job budget before paying.',
  },
  'project.status_changed': { priority: 'awareness', nextAction: null },
  'project.value_changed': {
    priority: 'decision',
    nextAction: 'Confirm the client agreed to the new figure and that the signed paperwork matches it.',
  },
  'project.schedule_changed': {
    priority: 'awareness',
    nextAction: 'Check whether any client commitment depends on the old date.',
  },
  'receipt.processed': { priority: 'routine', nextAction: null },
  'receipt.assigned_to_project': { priority: 'routine', nextAction: null },
  'pay_period.payroll_processed': { priority: 'routine', nextAction: null },
  'pay_period.paid': { priority: 'routine', nextAction: null },
  'payroll_entry.paid': { priority: 'routine', nextAction: null },
}

/** Conservative default for an entity type this policy has no opinion about yet. */
const DEFAULT_RULE: DomainAttentionRule = { priority: 'awareness', nextAction: null }

export interface DomainAttentionDeps {
  loadEvents: (workspaceId: string, since: Date, limit: number) => Promise<DomainAttentionEvent[]>
  /**
   * The workspace's own say on how loudly a change is raised — see
   * `lib/domain-policy.ts`. `null` means "no workspace policy on record",
   * which `ruleFor` treats identically to an empty config: every shipped
   * default applies. A read failure must fall back to `null` rather than
   * throwing — losing overrides is recoverable, losing delivery is not.
   */
  loadConfig: (workspaceId: string) => Promise<Record<string, unknown> | null>
  observe: typeof observeAttentionItem
}

export interface DomainAttentionResult {
  considered: number
  raised: number
  skipped: { bootstrap: number; unresolvable: number; muted: number }
}

/**
 * A bootstrap event is Caye seeing a record for the first time, not the source
 * system doing something. Raising those would announce every pre-existing row
 * as fresh activity the first time a ledger is connected — the same reasoning
 * `normalize.ts` uses when it attributes bootstrap to the system rather than
 * the outside world.
 */
function isFirstSight(event: DomainAttentionEvent): boolean {
  return event.payload.change_kind === 'bootstrap'
}

/** `domain.purchase_order.status_changed` -> `purchase_order.status_changed` */
export function ruleKeyFor(eventType: string): string {
  return eventType.startsWith('domain.') ? eventType.slice('domain.'.length) : eventType
}

const ATTENTION_PRIORITIES: ReadonlySet<string> = new Set<AttentionPriority>([
  'critical',
  'decision',
  'awareness',
  'routine',
])

function isAttentionPriority(value: string | undefined): value is AttentionPriority {
  return typeof value === 'string' && ATTENTION_PRIORITIES.has(value)
}

/**
 * The rule for one event, after the workspace's own policy has had its say.
 *
 * Precedence, and why each rung outranks the one below it:
 *
 *   1. A failed change is always `critical`. A workspace can retune how
 *      loudly a *successful* change is raised, but it cannot mute or
 *      downgrade a change that could not be processed — that is a
 *      correctness problem, not a preference, and nothing below this line
 *      gets a vote on it.
 *   2. A muted rule returns `null` rather than a low priority — "do not tell
 *      me about this" and "tell me quietly" are different instructions, and
 *      returning a rule object for either would blur them. The caller decides
 *      what to do with a skip; this function only reports one honestly.
 *   3. A workspace override is applied over the shipped rule field by field,
 *      so overriding `next_action` alone does not also reset `priority`. An
 *      override with an invalid priority (not one of `AttentionPriority`) is
 *      ignored rather than passed on to the ledger.
 *   4. The shipped table, then the conservative `awareness` fallback for an
 *      entity type the policy has no opinion about yet.
 */
export function ruleFor(
  eventType: string,
  isFailure: boolean,
  config?: Record<string, unknown> | null
): DomainAttentionRule | null {
  if (isFailure) {
    return { priority: 'critical', nextAction: 'A change could not be processed. Check the source record.' }
  }

  const ruleKey = ruleKeyFor(eventType)
  if (isMuted(config, ruleKey)) return null

  const shipped = CONSTRUCTION_ATTENTION_RULES[ruleKey] ?? DEFAULT_RULE
  const override = resolveAttentionOverride(config, ruleKey)
  if (!override) return shipped

  return {
    priority: isAttentionPriority(override.priority) ? override.priority : shipped.priority,
    // `'nextAction' in override` distinguishes an explicit `next_action: null`
    // (deliberately cleared) from an absent one (not overridden, so the
    // shipped next action still applies).
    nextAction: 'nextAction' in override ? (override.nextAction ?? null) : shipped.nextAction,
  }
}

/**
 * A label the owner will recognise.
 *
 * Never a raw UUID: `attention-presentation.ts` strips internal identifiers
 * from anything shown to an operator, so a title built from an id arrives
 * empty. Prefer whatever the source snapshot calls the thing, and fall back to
 * the entity type alone rather than leaking a key.
 */
export function labelFor(payload: DomainEventPayload): string {
  const snapshot = payload.snapshot ?? {}
  for (const field of ['po_number', 'estimate_number', 'name', 'invoice_number', 'title']) {
    const value = snapshot[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return humanise(payload.source?.entity_type ?? 'record')
}

function humanise(token: string): string {
  return token.replace(/_/g, ' ')
}

/**
 * "Purchase order PO-1042: status draft -> received"
 *
 * The changed fields are in the title rather than only in the fingerprint,
 * because an owner reading a briefing line should not have to open anything to
 * know what moved.
 */
export function titleFor(event: DomainAttentionEvent): string {
  const entity = humanise(event.payload.source?.entity_type ?? 'record')
  const label = labelFor(event.payload)
  const head = label === entity ? capitalise(entity) : `${capitalise(entity)} ${label}`

  const changes = event.payload.changes ?? []
  if (!changes.length) return head

  const described = changes
    .slice(0, 2)
    .map((c) => `${humanise(c.field)} ${format(c.previous)} → ${format(c.current)}`)
    .join(', ')
  return `${head}: ${described}`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function format(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none'
  return String(value)
}

/**
 * Only the fields whose change should re-earn the owner's attention.
 *
 * The event's own `changes` array is exactly that set — the normalizer already
 * dropped fields that churn without meaning. Including `observed_at` or the
 * event id here would make every re-observation look like news, which is the
 * behaviour the ledger's fingerprint exists to prevent.
 */
export function fingerprintPartsFor(event: DomainAttentionEvent): unknown[] {
  const changes = event.payload.changes ?? []
  return [
    event.type,
    ...changes.flatMap((c) => [c.field, format(c.current)]),
  ]
}

async function loadDomainEventsFromDb(
  workspaceId: string,
  since: Date,
  limit: number
): Promise<DomainAttentionEvent[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('workspace_events')
    .select('workspace_id, type, subject_id, is_failure, occurred_at, payload')
    .eq('workspace_id', workspaceId)
    .like('type', 'domain.%')
    .gte('occurred_at', since.toISOString())
    .order('occurred_at', { ascending: true })
    .limit(limit)

  if (error) throw new Error(`domain attention: could not read workspace_events — ${error.message}`)

  return (data ?? []).map((row) => ({
    workspaceId: row.workspace_id as string,
    type: row.type as string,
    subjectId: (row.subject_id as string | null) ?? null,
    isFailure: Boolean(row.is_failure),
    occurredAt: row.occurred_at as string,
    payload: (row.payload ?? {}) as DomainEventPayload,
  }))
}

const BEDROCK = 'bedrock'

/**
 * The workspace's construction-domain policy, straight from
 * `domain_source_connections.config.policy` for its active `bedrock`
 * connection.
 *
 * Any failure here — no connection, a revoked one, a query error — falls
 * back to `null` rather than throwing. `ruleFor` already treats `null`
 * identically to an empty config (every shipped default applies), so a
 * policy read failure loses the workspace's overrides for one pass, not the
 * whole projection. Losing overrides is recoverable; losing delivery is not.
 */
async function loadDomainPolicyConfig(workspaceId: string): Promise<Record<string, unknown> | null> {
  try {
    const connection = await getDomainSourceConnection(workspaceId, BEDROCK)
    return connection?.config ?? null
  } catch {
    return null
  }
}

/**
 * Raise owner attention for domain changes accepted since `since`.
 *
 * Idempotent by construction: `observeAttentionItem` keys on
 * (workspace, subject_type, subject_id) and suppresses an unchanged
 * fingerprint, so re-running over an overlapping window updates one row per
 * entity instead of stacking duplicates. That is why this takes a time window
 * rather than a cursor — an overlap is safe, and a missed event is not.
 */
export async function projectDomainEventsToAttention(args: {
  workspaceId: string
  since?: Date
  limit?: number
  deps?: Partial<DomainAttentionDeps>
}): Promise<DomainAttentionResult> {
  const since = args.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000)
  const limit = args.limit ?? 200
  const loadEvents = args.deps?.loadEvents ?? loadDomainEventsFromDb
  const loadConfig = args.deps?.loadConfig ?? loadDomainPolicyConfig
  const observe = args.deps?.observe ?? observeAttentionItem

  // One config read per workspace per pass, not per event — the policy does
  // not change mid-batch, and a batch can be 200 events.
  const [events, config] = await Promise.all([
    loadEvents(args.workspaceId, since, limit),
    loadConfig(args.workspaceId),
  ])
  const result: DomainAttentionResult = {
    considered: events.length,
    raised: 0,
    skipped: { bootstrap: 0, unresolvable: 0, muted: 0 },
  }

  for (const event of events) {
    if (isFirstSight(event)) {
      result.skipped.bootstrap++
      continue
    }

    // `subject_id` is `system:entity_type:entity_id`, written by the bridge and
    // stable across every event about one record. Without it there is nothing
    // to key attention on, and a synthesised key would split one record's
    // history into separate ledger rows.
    if (!event.subjectId) {
      result.skipped.unresolvable++
      continue
    }

    const rule = ruleFor(event.type, event.isFailure, config)
    if (!rule) {
      result.skipped.muted++
      continue
    }

    await observe({
      workspaceId: event.workspaceId,
      subjectType: SUBJECT_CONSTRUCTION_CHANGE,
      subjectId: event.subjectId,
      title: titleFor(event),
      priority: rule.priority,
      nextAction: rule.nextAction,
      fingerprintParts: fingerprintPartsFor(event),
      // The source system moved on its own. Nothing is waiting on the owner to
      // unblock it, and nothing here can be closed out by Caye acting alone.
      blockedOnOperator: false,
      resolvableAutonomously: false,
    })
    result.raised++
  }

  return result
}
