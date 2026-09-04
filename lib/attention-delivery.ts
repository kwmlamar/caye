import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOutbound } from '@/lib/whatsapp/outbound'
import { markAttentionNotified, type AttentionPriority } from '@/lib/owner-attention'
import {
  routeAttention,
  type RoutableAttentionItem,
  type RoutableOperator,
} from '@/lib/attention-routing'

/**
 * The last hop: a routed attention item becomes a message someone receives.
 *
 * WHY THIS EXISTS
 *
 * The construction ledger loop has raised attention items since it shipped
 * and nothing has ever delivered them. `lib/receivables-attention.ts`
 * computes the entire weekly ask — which invoices are outstanding, for how
 * long, whether a payment was ever confirmed — writes it to
 * `caye_owner_attention`, and stops. `lib/domain-attention.ts` and
 * `lib/freight-attention.ts` do the same.
 *
 * The ODS audit's single repeated finding was that work is done correctly and
 * the last step is missed: an unsigned contract escalated weekly into an inbox
 * that is 87% unread. Detecting a receivable perfectly and leaving it in a
 * table nobody opens is that same failure rebuilt one layer out. This module
 * is the missing step, and nothing else about the loop needed to change.
 *
 * WHAT IT DOES NOT DECIDE
 *
 * Not whether the item is news — `decideOperatorNotification` already
 * answered that against the attention ledger's own fingerprint and
 * interruption policy, and this runs only on a send outcome.
 * Not who owns it — `lib/attention-routing.ts` answers that, purely, from the
 * workspace's role configuration.
 * Not whether it may send — `enqueueOutbound` hard-gates on the workspace's
 * `notifications_paused`, which is the deliberate authority boundary. This
 * module deliberately does not check or bypass that flag: a workspace with
 * notifications paused runs every step here and enqueues nothing, which is
 * the intended behaviour, not a failure.
 *
 * So this is only: resolve the roster, ask routing who owns it, and enqueue
 * one row for that operator. An unrouted item is reported, never redirected —
 * routing refuses to guess, and a receivable reaching the wrong person is
 * worse than one nobody gets.
 */

export interface DeliverableAttentionItem extends RoutableAttentionItem {
  /** `caye_owner_attention.subject_id` — the ledger row this delivers. */
  subjectId: string
  /** Operator-facing one-liner. Already composed by the producer, which is
   *  the only place that knows the domain vocabulary. */
  title: string
  /** What the operator is being asked to do, if anything. */
  nextAction?: string | null
  priority?: AttentionPriority | null
}

export interface AttentionDeliveryDeps {
  loadRoster: (workspaceId: string) => Promise<RoutableOperator[]>
  loadRoleConfig: (workspaceId: string) => Promise<Record<string, unknown> | null>
  enqueue: typeof enqueueOutbound
  markNotified: typeof markAttentionNotified
  now: () => Date
}

export type AttentionDeliveryOutcome =
  | { delivered: true; operatorId: number; queueId: string; reason: string }
  | { delivered: false; reason: string }

export interface AttentionDeliveryResult {
  considered: number
  delivered: number
  /** Routed nowhere. Each entry carries routing's own explanation, which
   *  always names exactly what is missing — an unmapped role, an operator
   *  not on the roster, an unverified operator. */
  unrouted: { subjectId: string; reason: string }[]
  /** Routed, but the queue declined the row — almost always the workspace's
   *  `notifications_paused` gate, which is a correct outcome, not an error. */
  notQueued: { subjectId: string; reason: string }[]
}

/**
 * `operator_allowlist` -> `RoutableOperator`.
 *
 * `verified` is derived from `verified_at` (20260625_team_member_verification)
 * rather than stored as a boolean. Routing treats an unverified operator as
 * unroutable, which is why this cannot simply default to true: operator 35
 * (Omar, estimating) has never replied to the verification template, and his
 * items correctly route nowhere until he does.
 */
async function loadRosterFromDb(workspaceId: string): Promise<RoutableOperator[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('operator_allowlist')
    .select('id, name, phone, role, verified_at')
    .eq('workspace_id', workspaceId)

  if (error) throw new Error(`could not load operator roster — ${error.message}`)

  return (data ?? []).map((row) => ({
    id: row.id as number,
    name: (row.name as string | null) ?? null,
    phone: row.phone as string,
    role: row.role as string,
    verified: (row.verified_at as string | null) != null,
  }))
}

/**
 * The workspace's role -> operator mapping, from the same
 * `domain_source_connections.config` object `operator_profiles` lives on.
 * Only an active binding counts: a paused or revoked connection is a
 * deliberate instruction to stop, and routing off a dead binding's stale
 * roles would be exactly the wrong reading of it.
 */
async function loadRoleConfigFromDb(
  workspaceId: string
): Promise<Record<string, unknown> | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('domain_source_connections')
    .select('config')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`could not load role configuration — ${error.message}`)
  return (data?.config as Record<string, unknown> | null) ?? null
}

/**
 * Bucketed to the hour, matching `enqueueEscalationPings`. Keeps genuinely
 * separate sends distinct while collapsing retries and overlapping runs of
 * the same 30-minute cycle onto one key, so `enqueueOutbound`'s unique
 * constraint actually catches the duplicate instead of both firing.
 */
function hourBucket(now: Date): string {
  return new Date(Math.floor(now.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000)).toISOString()
}

/**
 * Deliver one already-decided attention item. Returns why, either way.
 */
export async function deliverAttentionItem(args: {
  workspaceId: string
  item: DeliverableAttentionItem
  roster: RoutableOperator[]
  roleConfig: Record<string, unknown> | null
  deps?: Partial<AttentionDeliveryDeps>
}): Promise<AttentionDeliveryOutcome> {
  const enqueue = args.deps?.enqueue ?? enqueueOutbound
  const markNotified = args.deps?.markNotified ?? markAttentionNotified
  const now = args.deps?.now ?? (() => new Date())

  const route = routeAttention(args.item, args.roster, args.roleConfig)
  if ('unrouted' in route) return { delivered: false, reason: route.reason }

  const operator = args.roster.find((o) => o.id === route.operatorId)
  // routeAttention only returns an id it found on this roster, so this is
  // unreachable — kept because the alternative is enqueueing a row with no
  // destination phone, which dispatch cannot do anything useful with.
  if (!operator) {
    return { delivered: false, reason: `Operator ${route.operatorId} vanished from the roster mid-delivery.` }
  }

  const queued = await enqueue({
    workspaceId: args.workspaceId,
    kind: 'construction_attention',
    payload: {
      to_phone: operator.phone,
      operator_allowlist_id: operator.id,
      operator_name: operator.name,
      subject_type: args.item.subjectType,
      subject_id: args.item.subjectId,
      entity_type: args.item.entityType ?? null,
      priority: args.item.priority ?? null,
      title: args.item.title,
      next_action: args.item.nextAction ?? null,
      // Why this person got it. Carried so the routing decision is auditable
      // from the queue row alone, without re-deriving it from config that
      // may since have changed.
      routing_reason: route.reason,
    },
    scheduledFor: now(),
    idempotencyKey: `construction_attention-${args.item.subjectType}-${args.item.subjectId}-${operator.id}-${hourBucket(now())}`,
  })

  if (!queued) {
    return {
      delivered: false,
      reason:
        'Queue declined the row — the workspace has notifications paused, or an identical row was already queued this hour.',
    }
  }

  // Record against the ledger only once the row actually exists, and carry
  // the queue id so the gate can later read this send's delivery status
  // without re-deriving which row it was.
  await markNotified({
    workspaceId: args.workspaceId,
    subjectType: args.item.subjectType,
    subjectId: args.item.subjectId,
    summary: args.item.title,
    queueId: queued.id,
  })

  return { delivered: true, operatorId: operator.id, queueId: queued.id, reason: route.reason }
}

/**
 * Deliver a batch, loading the roster and role configuration once.
 *
 * A per-item failure is recorded and the batch continues: one unmapped role
 * must not withhold every other operator's items, which is the same reason
 * `construction-ledger-cycle.ts` keeps its steps independent.
 */
export async function deliverAttentionItems(args: {
  workspaceId: string
  items: DeliverableAttentionItem[]
  deps?: Partial<AttentionDeliveryDeps>
}): Promise<AttentionDeliveryResult> {
  const result: AttentionDeliveryResult = {
    considered: args.items.length,
    delivered: 0,
    unrouted: [],
    notQueued: [],
  }
  if (args.items.length === 0) return result

  const loadRoster = args.deps?.loadRoster ?? loadRosterFromDb
  const loadRoleConfig = args.deps?.loadRoleConfig ?? loadRoleConfigFromDb

  const [roster, roleConfig] = await Promise.all([
    loadRoster(args.workspaceId),
    loadRoleConfig(args.workspaceId),
  ])

  for (const item of args.items) {
    const outcome = await deliverAttentionItem({
      workspaceId: args.workspaceId,
      item,
      roster,
      roleConfig,
      deps: args.deps,
    })

    if (outcome.delivered) {
      result.delivered++
    } else if (outcome.reason.startsWith('Queue declined')) {
      result.notQueued.push({ subjectId: item.subjectId, reason: outcome.reason })
    } else {
      result.unrouted.push({ subjectId: item.subjectId, reason: outcome.reason })
    }
  }

  return result
}
