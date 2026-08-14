import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveOpenEscalations } from '@/lib/caye-agent/tools/write-low/resolve-open-escalations'

export interface OwnerTaskCandidate {
  id: string
  workspaceId: string
  operatorId: number | null
  toolName: string
  summary: string
  conversationId: string | null
  customerName: string | null
  customerId: string | null
  createdAt: string
  expiresAt: string
  executedAt: string | null
  cancelledAt: string | null
  ownerHandledAt: string | null
  droppedReportedAt: string | null
  referenceTerms?: string[]
}

export type ActiveOwnerTaskResolution =
  | { status: 'matched'; task: OwnerTaskCandidate; basis: 'explicit' | 'previous-message' }
  | { status: 'ambiguous'; tasks: OwnerTaskCandidate[] }
  | { status: 'none' }

const CONTINUITY_HOURS = 24

/**
 * Conservative deterministic completion semantics at the classifier boundary.
 * This does not resolve a referent; it only says the owner reports that work
 * is already complete. The context resolver still decides which task, or asks.
 */
export function isOwnerCompletionStatement(text: string): boolean {
  const value = text.trim().toLowerCase().replace(/[.!]+$/, '')
  if (!value || value.endsWith('?')) return false
  if (/^(?:done|handled|completed|sorted|all set)$/.test(value)) return true
  if (/\b(?:i|we)\s+(?:(?:already|just)\s+)?(?:handled|completed|finished|sent|replied|responded|called|emailed|paid|booked|cancelled|canceled|resolved|took care of)\b/.test(value)) return true
  if (/\b(?:i|we)\s+.+\b(?:myself|ourselves)\b/.test(value) && /\b(?:sent|replied|handled|called|emailed|completed|did)\b/.test(value)) return true
  if (/^(?:do not|don't|dont) worry about (?:it|that|that one|this|this one)$/.test(value)) return true
  return false
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@.]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function identifyingTerms(task: OwnerTaskCandidate): string[] {
  const values = [task.id, task.conversationId, task.customerId, task.customerName, ...(task.referenceTerms ?? [])]
  const email = task.summary.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
  if (email) values.push(email)
  return values
    .filter((v): v is string => !!v?.trim())
    .flatMap((v) => {
      const whole = normalized(v)
      const nameParts = whole.split(' ').filter((part) => part.length >= 4)
      return [whole, ...nameParts]
    })
}

function textMatchesTask(text: string, task: OwnerTaskCandidate): boolean {
  const haystack = normalized(text)
  return identifyingTerms(task).some((term) => term.length >= 4 && haystack.includes(term))
}

/**
 * Deterministic conversational referent ranking for owner completion turns.
 * An explicit reference wins; otherwise the immediately preceding Caye message
 * may anchor exactly one durable action, including an action whose authorization
 * expired. Workspace-global held work is deliberately not a candidate here.
 */
export function rankActiveOwnerTask(args: {
  candidates: OwnerTaskCandidate[]
  explicitRef?: string
  previousCayeMessage?: string | null
}): ActiveOwnerTaskResolution {
  const liveHistory = args.candidates.filter(
    (task) => !task.executedAt && !task.ownerHandledAt && !task.cancelledAt
  )

  if (args.explicitRef?.trim()) {
    const matches = liveHistory.filter((task) => textMatchesTask(args.explicitRef!, task))
    if (matches.length === 1) return { status: 'matched', task: matches[0], basis: 'explicit' }
    if (matches.length > 1) return { status: 'ambiguous', tasks: matches }
    // An explicit customer that is not one of these durable tasks must not be
    // silently redirected to the preceding task.
    return { status: 'none' }
  }

  if (args.previousCayeMessage?.trim()) {
    const matches = liveHistory.filter((task) => textMatchesTask(args.previousCayeMessage!, task))
    if (matches.length === 1) {
      return { status: 'matched', task: matches[0], basis: 'previous-message' }
    }
    if (matches.length > 1) return { status: 'ambiguous', tasks: matches }
  }

  return { status: 'none' }
}

type Db = SupabaseClient

export async function resolveActiveOwnerTask(args: {
  supabase: Db
  workspaceId: string
  operatorId: number | null
  explicitRef?: string
  previousCayeMessage?: string | null
  now?: Date
}): Promise<ActiveOwnerTaskResolution> {
  const cutoff = new Date(
    (args.now ?? new Date()).getTime() - CONTINUITY_HOURS * 60 * 60 * 1000
  ).toISOString()

  let query = args.supabase
    .from('caye_pending_actions')
    .select(
      'id, workspace_id, operator_id, tool_name, summary, args, created_at, expires_at, executed_at, cancelled_at, owner_handled_at, dropped_reported_at'
    )
    .eq('workspace_id', args.workspaceId)
    .is('executed_at', null)
    .is('owner_handled_at', null)
    .gte('created_at', cutoff)
  query = args.operatorId == null
    ? query.is('operator_id', null)
    : query.eq('operator_id', args.operatorId)

  const { data, error } = await query.order('created_at', { ascending: false }).limit(25)
  if (error || !data) {
    console.error('[active-owner-task] candidate lookup failed:', error?.message)
    return { status: 'none' }
  }

  const conversationIds = [...new Set(data.map((row) => row.args?.conversation_id).filter(Boolean))]
  const bookingIds = [...new Set(data.map((row) => row.args?.booking_id).filter(Boolean))]
  const conversations = new Map<string, { customer_name: string | null; customer_id: string | null }>()
  const bookings = new Map<string, { customer_name: string | null; conversation_id: string | null }>()
  if (conversationIds.length > 0) {
    const { data: rows } = await args.supabase
      .from('unified_conversations')
      .select('id, customer_name, customer_id')
      .in('id', conversationIds)
    for (const row of rows ?? []) conversations.set(row.id, row)
  }
  if (bookingIds.length > 0) {
    const { data: rows } = await args.supabase
      .from('bookings')
      .select('id, customer_name, conversation_id')
      .eq('user_id', args.workspaceId)
      .in('id', bookingIds)
    for (const row of rows ?? []) bookings.set(row.id, row)
  }

  const candidates: OwnerTaskCandidate[] = data.map((row) => {
    const bookingId = row.args?.booking_id ?? null
    const booking = bookingId ? bookings.get(bookingId) : null
    const conversationId = row.args?.conversation_id ?? booking?.conversation_id ?? null
    const conversation = conversationId ? conversations.get(conversationId) : null
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      operatorId: row.operator_id,
      toolName: row.tool_name,
      summary: row.summary,
      conversationId,
      customerName: conversation?.customer_name ?? booking?.customer_name ?? null,
      customerId: conversation?.customer_id ?? null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      executedAt: row.executed_at,
      cancelledAt: row.cancelled_at,
      ownerHandledAt: row.owner_handled_at,
      droppedReportedAt: row.dropped_reported_at,
      referenceTerms: [bookingId, row.tool_name].filter((term): term is string => !!term),
    }
  })
  return rankActiveOwnerTask({
    candidates,
    explicitRef: args.explicitRef,
    previousCayeMessage: args.previousCayeMessage,
  })
}

/** Close the durable task without reviving or executing its authorization. */
export async function markOwnerTaskHandled(args: {
  supabase: Db
  task: OwnerTaskCandidate
  operatorId: number | null
  note?: string
  now?: Date
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const completedAt = (args.now ?? new Date()).toISOString()
  const { data, error } = await args.supabase
    .from('caye_pending_actions')
    .update({
      owner_handled_at: completedAt,
      owner_handled_by_operator_id: args.operatorId,
      owner_handled_note: args.note?.trim() || 'operator completed externally',
      // Existing workers already understand cancelled_at as non-actionable.
      // expires_at is intentionally untouched: authorization stays expired.
      cancelled_at: completedAt,
    })
    .eq('id', args.task.id)
    .eq('workspace_id', args.task.workspaceId)
    .is('executed_at', null)
    .is('owner_handled_at', null)
    .select('id')
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Task was already completed or is no longer actionable.' }

  if (args.task.conversationId) {
    await args.supabase
      .from('unified_conversations')
      .update({
        human_agent_enabled: false,
        human_agent_reason: args.note?.trim() || 'operator completed externally',
      })
      .eq('id', args.task.conversationId)
    await resolveOpenEscalations(args.supabase as never, args.task.conversationId)
    await args.supabase
      .from('caye_owner_attention')
      .update({ status: 'resolved', completed_at: completedAt, blocked_on_operator: false })
      .eq('workspace_id', args.task.workspaceId)
      .eq('conversation_id', args.task.conversationId)
      .neq('status', 'resolved')
  }
  return { ok: true }
}

export function ownerHandledAcknowledgement(task: OwnerTaskCandidate): string {
  const who = task.customerName || task.customerId || 'that task'
  const action = task.toolName === 'send_reply' ? 'reply' : 'task'
  return `Got it — I marked ${who}'s ${action} as handled by you. I won't send or follow up on it.`
}
