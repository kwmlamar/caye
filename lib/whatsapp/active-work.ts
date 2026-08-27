import 'server-only'
import type { OperatorIntent } from './intent'

/**
 * 'uncertain' (CAY-139, 2026-08-26) — the provider did not confirm whether
 * the write actually happened (a timeout/network failure with no HTTP
 * status to classify), so the outcome genuinely cannot be told apart from a
 * silent success. Distinct from 'failed': 'failed' means we KNOW nothing was
 * created (a deterministic rejection, an auth block, an unverified-mode
 * gate) and it is safe to say so plainly. Collapsing 'uncertain' into
 * 'failed' would be a false claim the same way collapsing it into
 * 'completed' would be — see draft-in-inbox.ts's failure classification.
 */
export type ActiveWorkStatus = 'editing' | 'ready' | 'executing' | 'failed' | 'completed' | 'uncertain'

export interface ActiveWork {
  sourceMessageId: string
  entityRef: string
  operation: 'customer_reply_draft'
  artifact: string | null
  status: ActiveWorkStatus
  createdAt: string
}

type IntentRecord = Record<string, unknown>

/**
 * Minimal durable current-work representation. It deliberately extends the
 * existing audit row instead of introducing a second task system: the current
 * operator turn already has the correct workspace/operator scope and is the
 * record replayed into the agent.
 */
export function seedActiveWork(operatorText: string, intent: OperatorIntent): ActiveWork | null {
  const entityRef = operatorText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()
  if (!entityRef || !/\b(?:draft|write|thank(?:\s+you)?|reply|email)\b/i.test(operatorText)) return null

  // A body introduced after a colon is draft material, not a second command.
  const colon = operatorText.indexOf(':')
  const artifact = colon >= 0 ? operatorText.slice(colon + 1).trim() || null : null
  return {
    sourceMessageId: '',
    entityRef,
    operation: 'customer_reply_draft',
    artifact,
    status: 'editing',
    createdAt: new Date().toISOString(),
  }
}

export function intentWithActiveWork(intent: OperatorIntent, work: ActiveWork | null): Record<string, unknown> {
  return work ? { ...(intent as unknown as IntentRecord), active_work: work } : intent as unknown as IntentRecord
}

export function activeWorkFromIntent(intent: unknown): ActiveWork | null {
  if (!intent || typeof intent !== 'object') return null
  const work = (intent as IntentRecord).active_work
  if (!work || typeof work !== 'object') return null
  const row = work as IntentRecord
  if (typeof row.entityRef !== 'string' || row.operation !== 'customer_reply_draft') return null
  if (!['editing', 'ready', 'executing', 'failed', 'completed', 'uncertain'].includes(String(row.status))) return null
  return {
    sourceMessageId: '',
    entityRef: row.entityRef,
    operation: 'customer_reply_draft',
    artifact: typeof row.artifact === 'string' ? row.artifact : null,
    status: row.status as ActiveWorkStatus,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
  }
}

export async function loadActiveWork(args: {
  supabase: { from: (table: string) => any }
  workspaceId: string
  operatorId: number
}): Promise<ActiveWork | null> {
  try {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const { data } = await args.supabase
    .from('caye_operator_messages')
    .select('id, intent, created_at')
    .eq('workspace_id', args.workspaceId)
    .eq('operator_allowlist_id', args.operatorId)
    .eq('direction', 'inbound')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(20)
  for (const row of data ?? []) {
    const work = activeWorkFromIntent(row.intent)
    if (work && work.status !== 'completed') return { ...work, sourceMessageId: row.id as string }
  }
  return null
  } catch {
    return null
  }
}

/**
 * Atomically-shaped lifecycle/artifact update for the exact work snapshot
 * supplied to this turn. Never searches for "the latest" task: a delayed
 * Jeff result must not be able to mutate a newer Bob task.
 */
export async function updateActiveWork(args: {
  supabase: { from: (table: string) => any }
  workspaceId: string
  operatorId: number | null | undefined
  work: Pick<ActiveWork, 'sourceMessageId' | 'entityRef' | 'operation'> | null | undefined
  artifact?: string
  status?: ActiveWorkStatus
}): Promise<boolean> {
  if (args.operatorId == null || !args.work || (!args.artifact && !args.status)) return false
  try {
  const { data: row } = await args.supabase
    .from('caye_operator_messages')
    .select('id, intent')
    .eq('workspace_id', args.workspaceId)
    .eq('operator_allowlist_id', args.operatorId)
    .eq('direction', 'inbound')
    .eq('id', args.work.sourceMessageId)
    .maybeSingle()
  const current = activeWorkFromIntent(row?.intent)
  if (!row || !current || current.entityRef !== args.work.entityRef || current.operation !== args.work.operation) return false
  const next = {
    ...current,
    ...(args.artifact ? { artifact: args.artifact } : {}),
    ...(args.status ? { status: args.status } : {}),
  }
  await args.supabase
    .from('caye_operator_messages')
    .update({ intent: { ...(row.intent as IntentRecord), active_work: next } })
    .eq('id', args.work.sourceMessageId)
  return true
  } catch {
    // Lifecycle metadata must not turn a completed operator action into a
    // failed one if the audit-store update itself is temporarily unavailable.
    return false
  }
}

export function isActiveWorkCorrection(text: string, work: ActiveWork | null): boolean {
  if (!work) return false
  const explicitEmail = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()
  if (explicitEmail && explicitEmail !== work.entityRef) return false
  return /\b(?:don'?t|do not|change|mention|add|remove|make|replace|instead|warmer|shorter|husband|driver)\b/i.test(text)
}

export function applyActiveWorkPrecedence(intent: OperatorIntent, text: string, work: ActiveWork | null): OperatorIntent {
  if (intent.kind === 'unclear' && isActiveWorkCorrection(text, work)) {
    return { kind: 'edit', item_ref: work!.entityRef, instruction: text }
  }
  return intent
}
