import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { EpisodeSelector, RawExportBundle } from './types'

/**
 * export/queries.ts — the ONLY file in this repo, outside a handful of
 * production route handlers, allowed to read real operational tables for
 * this purpose. Every query here is BOUNDED: an explicit workspace id
 * plus one anchor record (a conversation/booking/correction/tool-call
 * request/attention item/artifact) or an explicit, capped time window —
 * never `select('*')`, never an unscoped table scan. Column lists match
 * exactly what `export/build-raw-trace.ts` consumes; nothing is fetched
 * "just in case."
 *
 * Never queried, on principle, regardless of episode kind:
 *   - `business_artifacts.storage_path`/`storage_bucket` (would let a
 *     caller reach the real file bytes in Storage — episode capture only
 *     ever needs artifact METADATA, never the underlying media);
 *   - `customers.password_hash`/`stripe_*`/`whatsapp_business_id` or any
 *     other credential/integration-secret column;
 *   - `operator_allowlist.pending_otp_code`;
 *   - raw message `content`/`body` beyond what's needed to reconstruct
 *     the episode text (still raw at this layer — sanitize.ts's
 *     redaction is what makes it safe, not this file).
 *
 * This file requires real `NEXT_PUBLIC_SUPABASE_URL`/
 * `SUPABASE_SERVICE_ROLE_KEY` env vars to do anything at all
 * (`createServiceClient` throws otherwise) — there is no fallback, no
 * silent no-op mode that could be mistaken for a successful capture.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

// `EpisodeSelectorBase.windowHours` bounds conversation/booking/correction
// episodes via CONVERSATION_MESSAGE_LIMIT below rather than a computed
// timestamp range — those episode kinds anchor on an id (a specific
// conversation/booking/correction), and a row cap on "everything in that
// one conversation" is already a tight bound without needing a second,
// redundant time filter. A genuine `[startAt, endAt]` time-range query is
// what the dedicated `time-window` episode kind (captureTimeWindowEpisode
// below) is for.
const CONVERSATION_MESSAGE_LIMIT = 200
const TIME_WINDOW_DEFAULT_MAX_ROWS = 50
const TIME_WINDOW_HARD_MAX_ROWS = 200

async function fetchWorkspace(client: ServiceClient, workspaceId: string): Promise<RawExportBundle['workspace']> {
  const { data, error } = await client.from('customers').select('id, business_name, timezone').eq('id', workspaceId).maybeSingle()
  if (error) throw new Error(`export/queries: workspace lookup failed: ${error.message}`)
  if (!data) throw new Error(`export/queries: no workspace "${workspaceId}" — refusing to build a bundle with no identity anchor.`)
  return data as RawExportBundle['workspace']
}

async function fetchOperators(client: ServiceClient, workspaceId: string): Promise<RawExportBundle['operators']> {
  const { data, error } = await client
    .from('operator_allowlist')
    .select('id, workspace_id, phone, name, role')
    .eq('workspace_id', workspaceId)
  if (error) throw new Error(`export/queries: operator_allowlist fetch failed: ${error.message}`)
  return (data ?? []) as RawExportBundle['operators']
}

async function fetchConversationById(client: ServiceClient, conversationId: string): Promise<RawExportBundle['conversations']> {
  const { data, error } = await client
    .from('unified_conversations')
    .select('id, customer_name, channel_type, contact_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (error) throw new Error(`export/queries: unified_conversations fetch failed: ${error.message}`)
  return data ? [data as RawExportBundle['conversations'][number]] : []
}

async function fetchMessages(client: ServiceClient, conversationId: string): Promise<RawExportBundle['messages']> {
  const { data, error } = await client
    .from('unified_messages')
    .select('id, conversation_id, sender_type, is_internal, content, sent_at, sender_attribution')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true })
    .limit(CONVERSATION_MESSAGE_LIMIT)
  if (error) throw new Error(`export/queries: unified_messages fetch failed: ${error.message}`)
  return (data ?? []) as RawExportBundle['messages']
}

async function fetchBookingsForConversation(client: ServiceClient, conversationId: string, workspaceId: string): Promise<RawExportBundle['bookings']> {
  const { data, error } = await client
    .from('bookings')
    .select('id, user_id, customer_name, customer_email, conversation_id, booking_date, booking_time, status, tour_type_slug, created_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', workspaceId)
  if (error) throw new Error(`export/queries: bookings fetch (by conversation) failed: ${error.message}`)
  return (data ?? []) as RawExportBundle['bookings']
}

async function fetchAttentionForConversation(client: ServiceClient, conversationId: string, workspaceId: string): Promise<RawExportBundle['attentionItems']> {
  const { data, error } = await client
    .from('caye_owner_attention')
    .select(
      'id, workspace_id, subject_type, subject_id, conversation_id, title, priority, status, first_notified_at, last_notified_at, notify_count, last_notified_summary, acknowledged_at, decided_at, decision, next_action, completed_at, state_fingerprint, notified_fingerprint, operator_aware_fingerprint, operator_aware_at, operator_aware_summary, last_changed_at, digest'
    )
    .eq('conversation_id', conversationId)
    .eq('workspace_id', workspaceId)
  if (error) throw new Error(`export/queries: caye_owner_attention fetch (by conversation) failed: ${error.message}`)
  return (data ?? []) as RawExportBundle['attentionItems']
}

async function fetchBusinessFacts(client: ServiceClient, workspaceId: string, canonicalKeys?: string[]): Promise<RawExportBundle['businessFacts']> {
  let query = client
    .from('business_facts')
    .select('id, workspace_id, category, fact, canonical_key, created_by, created_at, superseded_at, superseded_by')
    .eq('workspace_id', workspaceId)
  if (canonicalKeys && canonicalKeys.length > 0) query = query.in('canonical_key', canonicalKeys)
  const { data, error } = await query.order('created_at', { ascending: true }).limit(TIME_WINDOW_HARD_MAX_ROWS)
  if (error) throw new Error(`export/queries: business_facts fetch failed: ${error.message}`)
  return (data ?? []) as RawExportBundle['businessFacts']
}

function emptyBundle(selector: EpisodeSelector, workspace: RawExportBundle['workspace'], operators: RawExportBundle['operators']): RawExportBundle {
  return {
    selector,
    workspace,
    operators,
    conversations: [],
    messages: [],
    operatorMessages: [],
    toolCalls: [],
    bookings: [],
    businessFacts: [],
    operatorLearningAudit: [],
    attentionItems: [],
    artifacts: [],
    artifactObservations: [],
    capturedAt: new Date().toISOString(),
  }
}

export async function captureConversationEpisode(client: ServiceClient, selector: Extract<EpisodeSelector, { kind: 'conversation' }>): Promise<RawExportBundle> {
  const workspace = await fetchWorkspace(client, selector.workspaceId)
  const operators = await fetchOperators(client, selector.workspaceId)
  const bundle = emptyBundle(selector, workspace, operators)
  bundle.conversations = await fetchConversationById(client, selector.conversationId)
  bundle.messages = await fetchMessages(client, selector.conversationId)
  bundle.bookings = await fetchBookingsForConversation(client, selector.conversationId, selector.workspaceId)
  bundle.attentionItems = await fetchAttentionForConversation(client, selector.conversationId, selector.workspaceId)
  return bundle
}

export async function captureBookingEpisode(client: ServiceClient, selector: Extract<EpisodeSelector, { kind: 'booking' }>): Promise<RawExportBundle> {
  const workspace = await fetchWorkspace(client, selector.workspaceId)
  const operators = await fetchOperators(client, selector.workspaceId)
  const bundle = emptyBundle(selector, workspace, operators)

  const { data: booking, error } = await client
    .from('bookings')
    .select('id, user_id, customer_name, customer_email, conversation_id, booking_date, booking_time, status, tour_type_slug, created_at')
    .eq('id', selector.bookingId)
    .eq('user_id', selector.workspaceId)
    .maybeSingle()
  if (error) throw new Error(`export/queries: booking fetch failed: ${error.message}`)
  if (!booking) throw new Error(`export/queries: no booking "${selector.bookingId}" in workspace "${selector.workspaceId}"`)
  bundle.bookings = [booking as RawExportBundle['bookings'][number]]

  const conversationId = (booking as { conversation_id?: string | null }).conversation_id
  if (conversationId) {
    bundle.conversations = await fetchConversationById(client, conversationId)
    bundle.messages = await fetchMessages(client, conversationId)
    bundle.attentionItems = await fetchAttentionForConversation(client, conversationId, selector.workspaceId)
  }
  return bundle
}

export async function captureCorrectionEpisode(client: ServiceClient, selector: Extract<EpisodeSelector, { kind: 'correction' }>): Promise<RawExportBundle> {
  const workspace = await fetchWorkspace(client, selector.workspaceId)
  const operators = await fetchOperators(client, selector.workspaceId)
  const bundle = emptyBundle(selector, workspace, operators)

  const { data: operatorMessage, error: omError } = await client
    .from('caye_operator_messages')
    .select('id, workspace_id, direction, body, created_at, operator_allowlist_id, operator_name, operator_role, origin')
    .eq('id', selector.sourceMessageId)
    .eq('workspace_id', selector.workspaceId)
    .maybeSingle()
  if (omError) throw new Error(`export/queries: caye_operator_messages fetch failed: ${omError.message}`)
  if (!operatorMessage) throw new Error(`export/queries: no operator message "${selector.sourceMessageId}" in workspace "${selector.workspaceId}"`)
  bundle.operatorMessages = [operatorMessage as RawExportBundle['operatorMessages'][number]]

  const { data: audit, error: auditError } = await client
    .from('operator_learning_audit')
    .select('id, workspace_id, source_operator_id, source_message_id, source_excerpt, decision, target_table, target_record_id, canonical_key, created_at')
    .eq('source_message_id', selector.sourceMessageId)
    .eq('workspace_id', selector.workspaceId)
  if (auditError) throw new Error(`export/queries: operator_learning_audit fetch failed: ${auditError.message}`)
  bundle.operatorLearningAudit = (audit ?? []) as RawExportBundle['operatorLearningAudit']

  const canonicalKeys = bundle.operatorLearningAudit.map((a) => a.canonical_key).filter((k): k is string => Boolean(k))
  if (canonicalKeys.length > 0) {
    bundle.businessFacts = await fetchBusinessFacts(client, selector.workspaceId, canonicalKeys)
  }
  return bundle
}

export async function captureConsequentialActionEpisode(client: ServiceClient, selector: Extract<EpisodeSelector, { kind: 'consequential-action' }>): Promise<RawExportBundle> {
  const workspace = await fetchWorkspace(client, selector.workspaceId)
  const operators = await fetchOperators(client, selector.workspaceId)
  const bundle = emptyBundle(selector, workspace, operators)

  const { data, error } = await client
    .from('caye_tool_calls')
    .select('id, workspace_id, request_id, operator_allowlist_id, caller_role, tool_name, risk, status, error_code, error, args, created_at')
    .eq('request_id', selector.requestId)
    .eq('workspace_id', selector.workspaceId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`export/queries: caye_tool_calls fetch failed: ${error.message}`)
  bundle.toolCalls = (data ?? []) as RawExportBundle['toolCalls']
  if (bundle.toolCalls.length === 0) {
    throw new Error(`export/queries: no tool calls for request_id "${selector.requestId}" in workspace "${selector.workspaceId}"`)
  }
  return bundle
}

export async function captureProactiveNotificationEpisode(client: ServiceClient, selector: Extract<EpisodeSelector, { kind: 'proactive-notification' }>): Promise<RawExportBundle> {
  const workspace = await fetchWorkspace(client, selector.workspaceId)
  const operators = await fetchOperators(client, selector.workspaceId)
  const bundle = emptyBundle(selector, workspace, operators)

  const { data: attention, error } = await client
    .from('caye_owner_attention')
    .select(
      'id, workspace_id, subject_type, subject_id, conversation_id, title, priority, status, first_notified_at, last_notified_at, notify_count, last_notified_summary, acknowledged_at, decided_at, decision, next_action, completed_at, state_fingerprint, notified_fingerprint, operator_aware_fingerprint, operator_aware_at, operator_aware_summary, last_changed_at, digest'
    )
    .eq('id', selector.attentionItemId)
    .eq('workspace_id', selector.workspaceId)
    .maybeSingle()
  if (error) throw new Error(`export/queries: caye_owner_attention fetch failed: ${error.message}`)
  if (!attention) throw new Error(`export/queries: no attention item "${selector.attentionItemId}" in workspace "${selector.workspaceId}"`)
  bundle.attentionItems = [attention as RawExportBundle['attentionItems'][number]]

  const conversationId = (attention as { conversation_id?: string | null }).conversation_id
  if (conversationId) {
    bundle.conversations = await fetchConversationById(client, conversationId)
    bundle.messages = await fetchMessages(client, conversationId)
  }
  return bundle
}

export async function captureArtifactEpisode(client: ServiceClient, selector: Extract<EpisodeSelector, { kind: 'artifact' }>): Promise<RawExportBundle> {
  const workspace = await fetchWorkspace(client, selector.workspaceId)
  const operators = await fetchOperators(client, selector.workspaceId)
  const bundle = emptyBundle(selector, workspace, operators)

  // Deliberately excludes storage_bucket/storage_path — see this file's
  // header comment. Metadata only.
  const { data: artifact, error } = await client
    .from('business_artifacts')
    .select('id, workspace_id, origin, modality, declared_mime_type, detected_mime_type, filename, created_at')
    .eq('id', selector.artifactId)
    .eq('workspace_id', selector.workspaceId)
    .maybeSingle()
  if (error) throw new Error(`export/queries: business_artifacts fetch failed: ${error.message}`)
  if (!artifact) throw new Error(`export/queries: no artifact "${selector.artifactId}" in workspace "${selector.workspaceId}"`)
  bundle.artifacts = [artifact as RawExportBundle['artifacts'][number]]

  const { data: observations, error: obsError } = await client
    .from('business_artifact_observations')
    .select('id, artifact_id, observation_type, content, created_at')
    .eq('artifact_id', selector.artifactId)
    .eq('workspace_id', selector.workspaceId)
    .order('created_at', { ascending: true })
    .limit(20)
  if (obsError) throw new Error(`export/queries: business_artifact_observations fetch failed: ${obsError.message}`)
  bundle.artifactObservations = (observations ?? []) as RawExportBundle['artifactObservations']
  return bundle
}

export async function captureTimeWindowEpisode(client: ServiceClient, selector: Extract<EpisodeSelector, { kind: 'time-window' }>): Promise<RawExportBundle> {
  const workspace = await fetchWorkspace(client, selector.workspaceId)
  const operators = await fetchOperators(client, selector.workspaceId)
  const bundle = emptyBundle(selector, workspace, operators)
  const limit = Math.min(selector.maxRowsPerTable ?? TIME_WINDOW_DEFAULT_MAX_ROWS, TIME_WINDOW_HARD_MAX_ROWS)

  const { data: operatorMessages, error: omError } = await client
    .from('caye_operator_messages')
    .select('id, workspace_id, direction, body, created_at, operator_allowlist_id, operator_name, operator_role, origin')
    .eq('workspace_id', selector.workspaceId)
    .gte('created_at', selector.startAt)
    .lte('created_at', selector.endAt)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (omError) throw new Error(`export/queries: caye_operator_messages (time-window) fetch failed: ${omError.message}`)
  bundle.operatorMessages = (operatorMessages ?? []) as RawExportBundle['operatorMessages']

  const { data: toolCalls, error: tcError } = await client
    .from('caye_tool_calls')
    .select('id, workspace_id, request_id, operator_allowlist_id, caller_role, tool_name, risk, status, error_code, error, args, created_at')
    .eq('workspace_id', selector.workspaceId)
    .gte('created_at', selector.startAt)
    .lte('created_at', selector.endAt)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (tcError) throw new Error(`export/queries: caye_tool_calls (time-window) fetch failed: ${tcError.message}`)
  bundle.toolCalls = (toolCalls ?? []) as RawExportBundle['toolCalls']

  const { data: bookings, error: bError } = await client
    .from('bookings')
    .select('id, user_id, customer_name, customer_email, conversation_id, booking_date, booking_time, status, tour_type_slug, created_at')
    .eq('user_id', selector.workspaceId)
    .gte('created_at', selector.startAt)
    .lte('created_at', selector.endAt)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (bError) throw new Error(`export/queries: bookings (time-window) fetch failed: ${bError.message}`)
  bundle.bookings = (bookings ?? []) as RawExportBundle['bookings']

  const { data: attention, error: aError } = await client
    .from('caye_owner_attention')
    .select(
      'id, workspace_id, subject_type, subject_id, conversation_id, title, priority, status, first_notified_at, last_notified_at, notify_count, last_notified_summary, acknowledged_at, decided_at, decision, next_action, completed_at, state_fingerprint, notified_fingerprint, operator_aware_fingerprint, operator_aware_at, operator_aware_summary, last_changed_at, digest'
    )
    .eq('workspace_id', selector.workspaceId)
    .gte('last_changed_at', selector.startAt)
    .lte('last_changed_at', selector.endAt)
    .order('last_changed_at', { ascending: true })
    .limit(limit)
  if (aError) throw new Error(`export/queries: caye_owner_attention (time-window) fetch failed: ${aError.message}`)
  bundle.attentionItems = (attention ?? []) as RawExportBundle['attentionItems']

  return bundle
}

export async function captureEpisode(selector: EpisodeSelector): Promise<RawExportBundle> {
  const client = createServiceClient()
  switch (selector.kind) {
    case 'conversation':
      return captureConversationEpisode(client, selector)
    case 'booking':
      return captureBookingEpisode(client, selector)
    case 'correction':
      return captureCorrectionEpisode(client, selector)
    case 'consequential-action':
      return captureConsequentialActionEpisode(client, selector)
    case 'proactive-notification':
      return captureProactiveNotificationEpisode(client, selector)
    case 'artifact':
      return captureArtifactEpisode(client, selector)
    case 'time-window':
      return captureTimeWindowEpisode(client, selector)
  }
}
