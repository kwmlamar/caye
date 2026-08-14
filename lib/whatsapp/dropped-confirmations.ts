/**
 * Find staged actions that quietly died — approved or not, never executed,
 * never cancelled, just expired with nobody told.
 *
 * WHY THIS EXISTS (2026-08-11)
 * Mrs. Max spent an afternoon clearing her queue with Caye. At 2:57pm Caye
 * staged the reply to Valencia Wills and asked "Ready to go to Valencia Wills
 * at exclusiveeventsllc@gmail.com. Confirm?". At 2:58pm she answered:
 *
 *   Mrs. Max:  yes
 *   Caye:      (nothing — no reply, no send, no error)
 *
 * The inbound was stored and the intent classifier ran, but the back-office
 * agent never made a single model call that turn. The staged row sat there and
 * expired at 3:12pm. As far as Mrs. Max knew, Valencia's email was sent.
 *
 * It went out at 3:49pm — 51 minutes late — and only because she happened to
 * come back and ask about a different customer, which made Caye notice the
 * stale row. Had she not, the email would never have been sent and nothing in
 * the system would ever have said so.
 *
 * WHY THIS IS THE FIX RATHER THAN CHASING THE DROP
 * The specific cause of that turn vanishing is still unproven. But this is the
 * third distinct way confirmations have been lost — args-mismatch restaging
 * (2026-08-01, Karenda confirmed one send five times in six minutes with
 * nothing going out), classifier-vs-agent routing (2026-08-07, fixed in
 * turn-ownership.ts), and now a turn disappearing outright. Each previous fix
 * closed one path and left the failure mode itself undetected.
 *
 * An operator saying "yes" and getting silence must be *noticed*, whatever
 * caused it. That is what this does, and it holds for causes not yet seen.
 *
 * Pure and DB-free so the supersede logic is unit-testable.
 */

/** Clock skew / in-flight tolerance before an expired row counts as dropped. */
export const GRACE_MS = 2 * 60 * 1000

/**
 * How far back to look. Beyond this a ping is archaeology, not a save — and on
 * first deploy it stops a backlog of historical rows all firing at once.
 */
export const REPORT_WINDOW_HOURS = 24

export interface PendingActionRow {
  id: string
  operator_id: number | null
  tool_name: string
  args: Record<string, unknown> | null
  summary: string | null
  created_at: string
  expires_at: string
  executed_at: string | null
  cancelled_at: string | null
  owner_handled_at?: string | null
  dropped_reported_at: string | null
}

export interface DroppedConfirmation {
  id: string
  operatorId: number | null
  toolName: string
  summary: string | null
  stagedAt: Date
}

/**
 * What counts as "the same thing" for supersede purposes.
 *
 * Keyed on the conversation, not the arguments. An operator revising a draft
 * ("don't say for as long as you need it") stages a fresh row with different
 * text against the same thread, and the earlier row is then meant to expire —
 * that is normal, and pinging about it would be pure noise. Keying on args
 * instead would treat every edit as a new dropped send.
 *
 * Tools with no conversation fall back to the tool name, which is coarser but
 * errs toward silence.
 */
export function supersedeKey(row: PendingActionRow): string {
  const args = row.args ?? {}
  const conversationId =
    typeof args.conversation_id === 'string' ? args.conversation_id : null
  return conversationId ? `${row.tool_name}:${conversationId}` : row.tool_name
}

/**
 * Rows that were staged, shown to the operator, and then silently went nowhere.
 *
 * A row is reported only when ALL of these hold:
 *   - not executed, not cancelled, not already reported
 *   - past expires_at + GRACE_MS
 *   - expired within REPORT_WINDOW_HOURS
 *   - no LATER row exists for the same operator and same supersede key
 *
 * That last rule is what keeps this quiet: on the afternoon this was written,
 * five of the day's ten staged rows expired unexecuted and only one of them —
 * Valencia's — was a real drop. The other four were drafts the operator had
 * revised, each superseded by the row that actually went out.
 */
export function selectDroppedConfirmations(args: {
  rows: PendingActionRow[]
  now: Date
  graceMs?: number
  windowHours?: number
}): DroppedConfirmation[] {
  const { rows, now } = args
  const graceMs = args.graceMs ?? GRACE_MS
  const windowHours = args.windowHours ?? REPORT_WINDOW_HOURS
  const windowStart = now.getTime() - windowHours * 60 * 60 * 1000

  // Latest staging time per operator+target, across every row regardless of
  // outcome — a later stage means the operator moved on from the earlier one.
  const latestStage = new Map<string, number>()
  for (const row of rows) {
    const key = `${row.operator_id ?? 'null'}|${supersedeKey(row)}`
    const at = Date.parse(row.created_at)
    if (Number.isNaN(at)) continue
    const seen = latestStage.get(key)
    if (seen === undefined || at > seen) latestStage.set(key, at)
  }

  const dropped: DroppedConfirmation[] = []

  for (const row of rows) {
    if (row.executed_at || row.cancelled_at || row.owner_handled_at || row.dropped_reported_at) continue

    const expiresAt = Date.parse(row.expires_at)
    const stagedAt = Date.parse(row.created_at)
    if (Number.isNaN(expiresAt) || Number.isNaN(stagedAt)) continue

    if (now.getTime() < expiresAt + graceMs) continue
    if (expiresAt < windowStart) continue

    const key = `${row.operator_id ?? 'null'}|${supersedeKey(row)}`
    const latest = latestStage.get(key)
    if (latest !== undefined && latest > stagedAt) continue

    dropped.push({
      id: row.id,
      operatorId: row.operator_id,
      toolName: row.tool_name,
      summary: row.summary,
      stagedAt: new Date(stagedAt),
    })
  }

  return dropped
}

/**
 * What the operator reads on their phone.
 *
 * Deliberately does NOT claim they approved it. The whole point is that we do
 * not know whether their answer reached us, and telling an owner "you said yes
 * and I ignored you" when they never answered would be its own bug. It states
 * the one fact that is certain — it did not go out — and offers the redo.
 */
export function formatDroppedConfirmation(
  dropped: DroppedConfirmation,
  timezone: string
): string {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(dropped.stagedAt)

  const what = describeStaged(dropped)

  return (
    `Heads up — ${what} I lined up at ${when} never went out, and it has now ` +
    `expired. If you told me to send it, it didn't reach me. ` +
    `Want me to set it back up?`
  )
}

/** A short noun phrase for the staged action, read cold with no context. */
function describeStaged(dropped: DroppedConfirmation): string {
  const recipient = recipientFromSummary(dropped.summary)

  switch (dropped.toolName) {
    case 'send_reply':
      return recipient ? `the reply to ${recipient}` : 'a reply'
    case 'send_payment_link':
      return recipient ? `the payment link for ${recipient}` : 'a payment link'
    case 'confirm_booking':
      return recipient ? `the booking confirmation for ${recipient}` : 'a booking confirmation'
    case 'cancel_booking':
      return recipient ? `the cancellation for ${recipient}` : 'a cancellation'
    case 'reschedule_booking':
      return recipient ? `the reschedule for ${recipient}` : 'a reschedule'
    case 'send_outreach_batch':
      return 'the outreach batch'
    default:
      return recipient ? `the action for ${recipient}` : 'something'
  }
}

/**
 * Pull the name out of a staged summary, which the gate writes as
 * "Send to Valencia Wills (email):\n\n...".
 */
export function recipientFromSummary(summary: string | null): string | null {
  if (!summary) return null
  const match = summary.match(/^\s*(?:Send|Sending)\s+to\s+([^(\n:]+)/i)
  const name = match?.[1]?.trim()
  return name && name.length <= 60 ? name : null
}
