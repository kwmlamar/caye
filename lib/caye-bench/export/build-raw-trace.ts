import type { BenchChannel, BenchEffect, BenchRisk } from '../types'
import type { Booking } from '../production-state'
import type { RawActorInput, RawEventInput, RawTraceInput, ReplaySeedArtifact } from '../replay/types'
import type { RawExportBundle } from './types'

/**
 * export/build-raw-trace.ts — pure reshaping, still fully raw/identifying.
 *
 * Turns a `RawExportBundle` (queries.ts's output) into a `RawTraceInput`
 * (the exact contract `sanitizeRawTrace`, unmodified since #168, already
 * expects). No redaction happens here — this file's only job is
 * "reconstruct the causal shape," not "make it safe." Every raw id below
 * is a real database id; `sanitizeRawTrace` is what turns them into
 * pseudonyms, and it must be the very next thing called on this output.
 *
 * RECONSTRUCTION RULES (what "legitimately observable" means per table):
 *   - `unified_messages` where `is_internal` is true are dropped — an
 *     internal note was never something a customer sent or received, so
 *     it isn't a customer-conversation INPUT event. (It may still shape
 *     `historicalEffects` indirectly via whatever tool call it caused;
 *     that's captured through `caye_tool_calls`, not this table.)
 *   - only INBOUND `caye_operator_messages` become input events — an
 *     OUTBOUND row is Caye's own reply, which belongs in
 *     `historicalEffects` (what actually happened), not in the events an
 *     operator "said."
 *   - `caye_tool_calls` become `historicalEffects` directly: a row in
 *     this table is, by construction, something that already ran through
 *     the real gate in production — `authorized: true` here reflects
 *     that fact about the SOURCE SYSTEM, not an assumption this exporter
 *     makes.
 *   - `bookings`/`caye_owner_attention` become `seed` state (what Caye
 *     could see going in), not events — matching how `production-state.ts`
 *     already models durable state versus a chronological event stream.
 */

const CHANNEL_MAP: Record<string, BenchChannel> = { whatsapp: 'whatsapp', email: 'email' }
function mapChannel(rawChannelType: string | null): BenchChannel {
  // BenchChannel (types.ts) only models whatsapp/email/caye_direct/system
  // today — instagram/messenger conversations map to 'whatsapp' as the
  // closest supported front-desk channel rather than failing the export.
  // This is a real, documented gap (same one the Explore report on
  // v2 found: front-desk for those two channels is still on the legacy
  // pre-convergence runtime, not runToolLoop) — a captured episode from
  // an instagram/messenger conversation replays through the whatsapp
  // front-desk path, not a faithful reproduction of that channel.
  if (!rawChannelType) return 'whatsapp'
  return CHANNEL_MAP[rawChannelType] ?? 'whatsapp'
}

function mapRisk(rawRisk: string | null): BenchRisk {
  if (rawRisk === 'read') return 'read'
  if (rawRisk === 'high') return 'high_write'
  return 'low_write'
}

function mapToolCallOutcome(status: string): { outcome: BenchEffect['outcome']; uncertainty: BenchEffect['uncertainty'] } {
  if (status === 'SUCCESS') return { outcome: 'success', uncertainty: 'none' }
  if (status === 'NEEDS_HUMAN') return { outcome: 'uncertain', uncertainty: 'ambiguous' }
  if (status === 'NOT_FOUND' || status === 'CONFLICT') return { outcome: 'blocked', uncertainty: 'none' }
  return { outcome: 'failed', uncertainty: 'none' }
}

function mapBookingStatus(rawStatus: string | null): Booking['status'] {
  if (rawStatus === 'confirmed' || rawStatus === 'completed' || rawStatus === 'cancelled') return rawStatus
  return 'pending'
}

export interface BuildRawTraceMeta {
  sourceDescription: string
  incidentRefs?: string[]
  exportedBy?: string
  notes?: string
}

export function buildRawTrace(bundle: RawExportBundle, meta: BuildRawTraceMeta): RawTraceInput {
  const actors: RawActorInput[] = []
  const seenActorIds = new Set<string>()
  function addActor(actor: RawActorInput): string {
    if (!seenActorIds.has(actor.rawId)) {
      seenActorIds.add(actor.rawId)
      actors.push(actor)
    }
    return actor.rawId
  }

  const systemActorId = addActor({ rawId: 'system', role: 'system' })

  for (const op of bundle.operators) {
    addActor({
      // BenchActorRole (types.ts) has no 'founder' value — a real
      // production founder-role operator maps to the bench's generic
      // 'operator' role, same authority tier replay-adapter.ts already
      // gives any non-staff back-office actor.
      rawId: `operator:${op.id}`,
      role: op.role === 'staff' ? 'staff' : op.role === 'owner' ? 'owner' : 'operator',
      displayName: op.name,
      phone: op.phone,
    })
  }

  const conversationChannel = new Map<string, string | null>()
  const conversationActorId = new Map<string, string>()
  for (const conv of bundle.conversations) {
    conversationChannel.set(conv.id, conv.channel_type)
    conversationActorId.set(conv.id, addActor({ rawId: `customer:${conv.id}`, role: 'customer', displayName: conv.customer_name }))
  }

  const events: RawEventInput[] = []

  for (const m of bundle.messages) {
    if (m.is_internal) continue
    const isCustomer = m.sender_type === 'customer'
    const actorRawId = isCustomer ? (conversationActorId.get(m.conversation_id) ?? addActor({ rawId: `customer:${m.conversation_id}`, role: 'customer' })) : systemActorId
    events.push({
      id: `msg-${m.id}`,
      at: m.sent_at ?? bundle.capturedAt,
      channel: mapChannel(conversationChannel.get(m.conversation_id) ?? null) as RawEventInput['channel'],
      actorRawId,
      kind: 'message',
      text: m.content ?? undefined,
    })
  }

  for (const om of bundle.operatorMessages) {
    if (om.direction !== 'inbound') continue
    const actorRawId = om.operator_allowlist_id != null ? addActor({ rawId: `operator:${om.operator_allowlist_id}`, role: om.operator_role === 'staff' ? 'staff' : om.operator_role === 'owner' ? 'owner' : 'operator', displayName: om.operator_name }) : systemActorId
    events.push({
      id: `opmsg-${om.id}`,
      at: om.created_at ?? bundle.capturedAt,
      channel: om.origin === 'dashboard' ? 'caye_direct' : 'whatsapp',
      actorRawId,
      kind: 'message',
      text: om.body ?? undefined,
    })
  }

  const businessFactById = new Map(bundle.businessFacts.map((f) => [f.id, f]))
  for (const audit of bundle.operatorLearningAudit) {
    const actorRawId = audit.source_operator_id != null ? addActor({ rawId: `operator:${audit.source_operator_id}` , role: 'owner' }) : systemActorId
    const writtenFact = audit.target_record_id ? businessFactById.get(audit.target_record_id) : undefined
    events.push({
      id: `correction-${audit.id}`,
      at: audit.created_at ?? bundle.capturedAt,
      channel: 'whatsapp',
      actorRawId,
      kind: 'correction',
      text: audit.source_excerpt,
      data:
        audit.canonical_key && writtenFact
          ? { factKey: audit.canonical_key, factValue: writtenFact.fact }
          : undefined,
    })
  }

  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  const bookingsSeed: Booking[] = bundle.bookings.map((b) => ({
    id: `booking-${b.id}`,
    customerId: b.conversation_id ? (conversationActorId.get(b.conversation_id) ?? systemActorId) : systemActorId,
    customerName: b.customer_name ?? 'Unknown',
    tourType: b.tour_type_slug ?? 'unknown',
    date: b.booking_date,
    time: b.booking_time,
    status: mapBookingStatus(b.status),
    reviewRequestedAt: null,
  }))

  const businessFactsSeed: Record<string, string> = {}
  for (const fact of bundle.businessFacts) {
    if (fact.superseded_at) continue // only the currently-live fact is "what Caye could observe now"
    businessFactsSeed[fact.canonical_key ?? fact.id] = fact.fact
  }

  const artifactsSeed: ReplaySeedArtifact[] = bundle.artifacts.map((a) => {
    const caption = bundle.artifactObservations
      .filter((o) => o.artifact_id === a.id && (o.observation_type === 'summary' || o.observation_type === 'visual_description'))
      .map((o) => summarizeObservationContent(o.content))
      .find((s): s is string => Boolean(s))
    return { id: `artifact-${a.id}`, caption: caption ?? `${a.modality ?? 'file'} artifact (${a.declared_mime_type ?? 'unknown type'})`, mime: a.detected_mime_type ?? a.declared_mime_type ?? 'application/octet-stream' }
  })

  const attentionSeed = bundle.attentionItems.map((item) => ({
    id: `attention-${item.id}`,
    workspace_id: bundle.workspace.id,
    subject_type: item.subject_type,
    subject_id: item.subject_id,
    conversation_id: item.conversation_id,
    title: item.title,
    priority: item.priority as 'critical' | 'decision' | 'awareness' | 'routine',
    status: item.status as 'open' | 'acknowledged' | 'decided' | 'resolved' | 'dismissed',
    first_notified_at: item.first_notified_at,
    last_notified_at: item.last_notified_at,
    notify_count: item.notify_count,
    last_notified_summary: item.last_notified_summary,
    acknowledged_at: item.acknowledged_at,
    decided_at: item.decided_at,
    decision: item.decision,
    next_action: item.next_action,
    completed_at: item.completed_at,
    state_fingerprint: item.state_fingerprint,
    notified_fingerprint: item.notified_fingerprint,
    operator_aware_fingerprint: item.operator_aware_fingerprint,
    operator_aware_at: item.operator_aware_at,
    operator_aware_summary: item.operator_aware_summary,
    last_changed_at: item.last_changed_at,
    digest: null,
  }))

  const historicalEffects: BenchEffect[] = bundle.toolCalls.map((tc) => {
    const { outcome, uncertainty } = mapToolCallOutcome(tc.status)
    return {
      id: `toolcall-${tc.id}`,
      workspaceId: 'placeholder', // remapped by sanitizeRawTrace
      at: tc.created_at ?? bundle.capturedAt,
      kind: 'tool_call',
      risk: mapRisk(tc.risk),
      consequential: tc.risk !== 'read',
      // A row existing in caye_tool_calls means it already passed through
      // the real production gate/role-check when it happened — this
      // reflects a fact about the source system, not an assumption.
      authorized: true,
      outcome,
      uncertainty,
      evidence: [{ kind: 'tool_result', ref: tc.tool_name, summary: tc.error ?? tc.error_code ?? tc.status }],
      metadata: { tool: tc.tool_name, requestId: tc.request_id },
    }
  })

  const firstEventAt = events[0]?.at ?? bundle.toolCalls[0]?.created_at ?? bundle.capturedAt

  return {
    workspaceRawId: bundle.workspace.id,
    sourceDescription: meta.sourceDescription,
    incidentRefs: meta.incidentRefs,
    timezone: bundle.workspace.timezone ?? 'America/Nassau',
    businessName: bundle.workspace.business_name ?? 'Unknown Business',
    startTime: firstEventAt,
    actors,
    events,
    seed: { bookings: bookingsSeed, businessFacts: businessFactsSeed, artifacts: artifactsSeed, attentionItems: attentionSeed },
    historicalEffects,
    provenance: { sourceSystem: 'supabase-production-export', exportedBy: meta.exportedBy, notes: meta.notes },
  }
}

/** Extracts a short text summary from an artifact observation's `content`
 *  jsonb without trusting its shape — that column is explicitly untrusted
 *  extracted content (OCR/model output), never assumed to be a specific
 *  schema. Falls back to `undefined` (caller supplies a generic caption)
 *  rather than guessing at a shape that doesn't match. */
function summarizeObservationContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    for (const key of ['summary', 'text', 'description']) {
      if (typeof record[key] === 'string') return record[key] as string
    }
  }
  return undefined
}
