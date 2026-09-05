import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { inQuietHours, loadScheduleConfig } from '@/lib/whatsapp/schedule'
import { SUBJECT_RECEIVABLE } from '@/lib/receivables-attention'
import { SUBJECT_PAYMENT_SIGNAL } from '@/lib/payment-watcher/propose'
import { SUBJECT_PAYMENT_WATCHER_WEEKLY_DIGEST } from '@/lib/payment-watcher/weekly-aging-nudge'
import {
  deliverAttentionItems,
  type AttentionDeliveryDeps,
  type AttentionDeliveryResult,
  type DeliverableAttentionItem,
} from '@/lib/attention-delivery'
import type { AttentionPriority } from '@/lib/owner-attention'

/**
 * Read the construction attention ledger and deliver what nobody has been
 * told yet.
 *
 * WHY A SEPARATE STEP RATHER THAN A CHANGE TO THE PRODUCERS
 *
 * `caye_owner_attention` already carries exactly the state this needs, and
 * carries it precisely for this purpose. `state_fingerprint` is the item's
 * meaningful state now; `notified_fingerprint` is what it was when someone
 * was last told. The schema's own comment on those columns says it plainly:
 * equal means nothing changed since the owner was told, so do not re-surface
 * as new. Reading that comparison is therefore not a second, competing
 * notion of "is this news" — it is the one the ledger was built around.
 *
 * That is what lets this be additive. `raiseReceivablesAttention` is
 * untouched, and so is its contract: it observes the ledger and returns what
 * it considered. `construction-ledger-cycle.ts` already keeps its steps
 * independent so one failure cannot withhold another's work, and this is a
 * fourth step under the same rule.
 *
 * SCOPE
 *
 * Receivables only, deliberately. The routing table already has rules for
 * pay periods, purchase orders, projects, receipts, estimates and freight,
 * and `deliverAttentionItems` is domain-agnostic — extending this is adding
 * a subject type to `DELIVERABLE_SUBJECT_TYPES` below, not writing a second
 * delivery path. Each domain is worth turning on deliberately, once someone
 * has decided that domain's items are worth interrupting a person for.
 *
 * WHAT STOPS IT SENDING
 *
 * Three independent gates, none of which this module weakens:
 *   - quiet hours, checked here, the same way every other proactive cron
 *     checks them (opportunity-scan, business-insights). The owner's setting.
 *   - `notifications_paused`, enforced inside `enqueueOutbound`. As of this
 *     writing ODS has it set, so this step runs end to end and enqueues
 *     nothing. That is the intended behaviour: who receives the first
 *     unprompted message is a decision for the business, not a default.
 *   - routing, which refuses to hand an item to an unmapped or unverified
 *     operator rather than falling back to someone else.
 */

/** Extend deliberately, one domain at a time. See SCOPE above. */
const DELIVERABLE_SUBJECT_TYPES: string[] = [
  SUBJECT_RECEIVABLE,
  SUBJECT_PAYMENT_SIGNAL,
  // Wired but inert while the weekly nudge ships disabled by default (see
  // lib/payment-watcher/weekly-aging-nudge.ts) — nothing raises this subject
  // type until PAYMENT_WATCHER_WEEKLY_NUDGE_ENABLED is turned on.
  SUBJECT_PAYMENT_WATCHER_WEEKLY_DIGEST,
]

/**
 * Statuses that mean a human has not finished with the item.
 * `caye_owner_attention.status` also allows 'decided', 'resolved' and
 * 'dismissed' (20260812c) — all three mean someone has already dealt with it,
 * so delivering them would be telling a person something they closed.
 */
const OPEN_STATUSES: string[] = ['open', 'acknowledged']

export interface ConstructionAttentionDeliveryDeps extends AttentionDeliveryDeps {
  loadUndelivered: (workspaceId: string) => Promise<DeliverableAttentionItem[]>
  isQuietHours: (workspaceId: string, now: Date) => Promise<boolean>
}

export type ConstructionAttentionDeliveryResult =
  | (AttentionDeliveryResult & { skipped?: undefined })
  | { skipped: 'quiet_hours'; considered: 0; delivered: 0; unrouted: []; notQueued: [] }

/**
 * Rows nobody has been told about, or whose state has moved since they were.
 *
 * `pending_notification_queue_id` is excluded rather than ignored: a row
 * already queued and not yet dispatched has been decided on, and re-queueing
 * it would double-send the moment the worker catches up. `loadAttentionDelta`
 * self-heals a pointer left dangling by a failed send, so this cannot wedge
 * permanently.
 */
/**
 * Is this item news to whoever owns it?
 *
 * Never told (`notifiedFingerprint` null), or the item's meaningful state has
 * moved since they were told. Equal fingerprints mean this is the same fact
 * they already have, and re-sending it is how an alerting channel trains the
 * person receiving it to ignore the channel — the failure the whole ledger
 * exists to avoid.
 *
 * Note what `receivables-attention.ts` deliberately leaves OUT of the
 * fingerprint: the invoice's age. An invoice that is one day older is not
 * news. It becomes news when the balance changes or a payment is first
 * recorded. So an unpaid invoice is delivered once and then sits quietly
 * until something about it actually changes, rather than nagging daily.
 *
 * A null `stateFingerprint` (a producer that did not supply fingerprint
 * parts) is treated as news every pass. That is the honest reading — without
 * a fingerprint there is no evidence the item is unchanged — and it is why
 * every construction producer supplies one.
 */
export function isUndelivered(row: {
  stateFingerprint: string | null
  notifiedFingerprint: string | null
}): boolean {
  if (row.notifiedFingerprint == null) return true
  return row.notifiedFingerprint !== row.stateFingerprint
}

async function loadUndeliveredFromDb(workspaceId: string): Promise<DeliverableAttentionItem[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_owner_attention')
    .select('subject_type, subject_id, title, priority, next_action, state_fingerprint, notified_fingerprint')
    .eq('workspace_id', workspaceId)
    .in('subject_type', DELIVERABLE_SUBJECT_TYPES)
    .in('status', OPEN_STATUSES)
    .is('pending_notification_queue_id', null)

  if (error) throw new Error(`could not read the attention ledger — ${error.message}`)

  return (data ?? [])
    .filter((row) =>
      isUndelivered({
        stateFingerprint: row.state_fingerprint as string | null,
        notifiedFingerprint: row.notified_fingerprint as string | null,
      })
    )
    .map((row) => ({
      subjectType: row.subject_type as string,
      subjectId: row.subject_id as string,
      title: row.title as string,
      priority: (row.priority as AttentionPriority | null) ?? null,
      nextAction: (row.next_action as string | null) ?? null,
    }))
}

async function isQuietHoursFromDb(workspaceId: string, now: Date): Promise<boolean> {
  return inQuietHours(now, await loadScheduleConfig(workspaceId))
}

export async function deliverConstructionAttention(args: {
  workspaceId: string
  deps?: Partial<ConstructionAttentionDeliveryDeps>
}): Promise<ConstructionAttentionDeliveryResult> {
  const loadUndelivered = args.deps?.loadUndelivered ?? loadUndeliveredFromDb
  const isQuiet = args.deps?.isQuietHours ?? isQuietHoursFromDb
  const now = args.deps?.now ?? (() => new Date())

  // Checked before reading the ledger: nothing here is urgent enough to wake
  // someone, and an outstanding invoice will still be outstanding at 7am.
  if (await isQuiet(args.workspaceId, now())) {
    return { skipped: 'quiet_hours', considered: 0, delivered: 0, unrouted: [], notQueued: [] }
  }

  const items = await loadUndelivered(args.workspaceId)
  return deliverAttentionItems({ workspaceId: args.workspaceId, items, deps: args.deps })
}
