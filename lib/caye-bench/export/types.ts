/**
 * export/types.ts — the capture-boundary's own shapes.
 *
 * `RawExportBundle` is deliberately NOT `RawTraceInput`
 * (`lib/caye-bench/replay/types.ts`) — it's the still-raw, still-
 * identifying intermediate the bounded Supabase queries (`queries.ts`)
 * produce, kept strictly in memory and NEVER serialized to disk as-is.
 * `build-raw-trace.ts` turns it into a `RawTraceInput`; `sanitizeRawTrace`
 * (already exists, unmodified) turns THAT into a `ReplayTrace`. Only the
 * final, sanitized `ReplayTrace` — after `verify-sanitized.ts` passes —
 * is ever eligible to touch a file path.
 */

export type EpisodeKind = 'conversation' | 'booking' | 'correction' | 'consequential-action' | 'proactive-notification' | 'artifact' | 'time-window'

export interface EpisodeSelectorBase {
  /** Real workspace (customers.id) — required on every selector so a
   *  bounded query can never accidentally span workspaces. */
  workspaceId: string
}

export interface ConversationEpisodeSelector extends EpisodeSelectorBase {
  kind: 'conversation'
  conversationId: string
}

export interface BookingEpisodeSelector extends EpisodeSelectorBase {
  kind: 'booking'
  bookingId: string
}

export interface CorrectionEpisodeSelector extends EpisodeSelectorBase {
  kind: 'correction'
  /** The operator_learning_audit row (or, if unavailable, the
   *  caye_operator_messages row) that IS the correction. */
  sourceMessageId: string
}

export interface ConsequentialActionEpisodeSelector extends EpisodeSelectorBase {
  kind: 'consequential-action'
  /** caye_tool_calls.request_id — one inbound-message handling pass. */
  requestId: string
}

export interface ProactiveNotificationEpisodeSelector extends EpisodeSelectorBase {
  kind: 'proactive-notification'
  attentionItemId: string
}

export interface ArtifactEpisodeSelector extends EpisodeSelectorBase {
  kind: 'artifact'
  artifactId: string
}

export interface TimeWindowEpisodeSelector extends EpisodeSelectorBase {
  kind: 'time-window'
  startAt: string
  endAt: string
  /** Hard cap on rows pulled per table — a time-window episode is the
   *  closest thing to "dump a slice of a table," so this bound is
   *  mandatory, not optional, and enforced in queries.ts regardless of
   *  what's passed here (this only lowers it, never raises it). */
  maxRowsPerTable?: number
}

export type EpisodeSelector =
  | ConversationEpisodeSelector
  | BookingEpisodeSelector
  | CorrectionEpisodeSelector
  | ConsequentialActionEpisodeSelector
  | ProactiveNotificationEpisodeSelector
  | ArtifactEpisodeSelector
  | TimeWindowEpisodeSelector

/** Raw row shapes — ONLY the columns queries.ts actually selects (never
 *  `select('*')`), matching exactly what build-raw-trace.ts consumes.
 *  Deliberately loose (`Record<string, unknown>`-adjacent) rather than
 *  binding to generated Supabase types, matching how the rest of this
 *  codebase's server-side Supabase access is typed (lib/supabase-server.ts's
 *  createServiceClient has no `Database` generic applied). */
export interface RawConversationRow {
  id: string
  customer_name: string | null
  channel_type: string | null
  contact_id: string | null
}
export interface RawMessageRow {
  id: string
  conversation_id: string
  sender_type: string | null
  is_internal: boolean | null
  content: string | null
  sent_at: string | null
  sender_attribution: string | null
}
export interface RawOperatorMessageRow {
  id: string
  workspace_id: string
  direction: string | null
  body: string | null
  created_at: string | null
  operator_allowlist_id: number | null
  operator_name: string | null
  operator_role: string | null
  origin: string | null
}
export interface RawToolCallRow {
  id: string
  workspace_id: string | null
  request_id: string | null
  operator_allowlist_id: number | null
  caller_role: string | null
  tool_name: string
  risk: string | null
  status: string
  error_code: string | null
  error: string | null
  args: unknown
  created_at: string | null
}
export interface RawBookingRow {
  id: string
  user_id: string
  customer_name: string | null
  customer_email: string | null
  conversation_id: string | null
  booking_date: string | null
  booking_time: string | null
  status: string | null
  tour_type_slug: string | null
  created_at: string | null
}
export interface RawBusinessFactRow {
  id: string
  workspace_id: string
  category: string
  fact: string
  canonical_key: string | null
  created_by: string | null
  created_at: string | null
  superseded_at: string | null
  superseded_by: string | null
}
export interface RawOperatorLearningAuditRow {
  id: number
  workspace_id: string
  source_operator_id: number | null
  source_message_id: string | null
  source_excerpt: string
  decision: string
  target_table: string | null
  target_record_id: string | null
  canonical_key: string | null
  created_at: string | null
}
export interface RawAttentionRow {
  id: string
  workspace_id: string
  subject_type: string
  subject_id: string
  conversation_id: string | null
  title: string
  priority: string
  status: string
  first_notified_at: string | null
  last_notified_at: string | null
  notify_count: number
  last_notified_summary: string | null
  acknowledged_at: string | null
  decided_at: string | null
  decision: string | null
  next_action: string | null
  completed_at: string | null
  state_fingerprint: string
  notified_fingerprint: string | null
  operator_aware_fingerprint: string | null
  operator_aware_at: string | null
  operator_aware_summary: string | null
  last_changed_at: string
  digest: unknown
}
export interface RawArtifactRow {
  id: string
  workspace_id: string
  origin: string | null
  modality: string | null
  declared_mime_type: string | null
  detected_mime_type: string | null
  filename: string | null
  created_at: string | null
}
export interface RawArtifactObservationRow {
  id: string
  artifact_id: string
  observation_type: string
  content: unknown
  created_at: string | null
}
export interface RawOperatorAllowlistRow {
  id: number
  workspace_id: string
  phone: string | null
  name: string | null
  role: string
}
/** `caye_pending_actions` — the ONLY table that actually distinguishes a
 *  high-risk tool call that was merely STAGED (awaiting confirmation) from
 *  one that was genuinely confirmed and executed (`executed_at` set). See
 *  `build-raw-trace.ts`'s header comment for why this matters: a
 *  `caye_tool_calls` row alone cannot tell the two apart — and `tool_name`
 *  alone cannot tell WHICH specific call a given pending action belongs
 *  to when two concurrent calls to the same tool exist (e.g. two
 *  customers each getting a `send_payment_link`). `argsKeyHash` (a sha256
 *  of production's own `stableArgsKey(args)` — see `export/args-key.ts`)
 *  is what makes that correlation precise; `operatorId` narrows it
 *  further, mirroring `high-risk-gate.ts`'s own resubmission-match query
 *  scope. Never the raw `args_key` string itself — see args-key.ts's
 *  header comment for why. */
export interface RawPendingActionRow {
  id: string
  workspace_id: string
  tool_name: string
  argsKeyHash: string | null
  operatorId: number | null
  created_in_request_id: string | null
  created_at: string | null
  executed_at: string | null
  cancelled_at: string | null
}
export interface RawWorkspaceRow {
  id: string
  business_name: string | null
  timezone: string | null
}

export interface RawExportBundle {
  selector: EpisodeSelector
  workspace: RawWorkspaceRow
  operators: RawOperatorAllowlistRow[]
  conversations: RawConversationRow[]
  messages: RawMessageRow[]
  operatorMessages: RawOperatorMessageRow[]
  toolCalls: RawToolCallRow[]
  pendingActions: RawPendingActionRow[]
  bookings: RawBookingRow[]
  businessFacts: RawBusinessFactRow[]
  operatorLearningAudit: RawOperatorLearningAuditRow[]
  attentionItems: RawAttentionRow[]
  artifacts: RawArtifactRow[]
  artifactObservations: RawArtifactObservationRow[]
  capturedAt: string
}
