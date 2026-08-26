import 'server-only'
import type { OperatorIntent } from './intent'

export type ActiveWorkStatus = 'editing' | 'ready' | 'executing' | 'failed' | 'completed'

export interface ActiveWork {
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
  if (!['editing', 'ready', 'executing', 'failed', 'completed'].includes(String(row.status))) return null
  return {
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
    .select('intent, created_at')
    .eq('workspace_id', args.workspaceId)
    .eq('operator_allowlist_id', args.operatorId)
    .eq('direction', 'inbound')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(20)
  for (const row of data ?? []) {
    const work = activeWorkFromIntent(row.intent)
    if (work && work.status !== 'completed') return work
  }
  return null
  } catch {
    return null
  }
}

/** Best-effort lifecycle update for the same durable audit record. */
export async function setLatestActiveWorkStatus(args: {
  supabase: { from: (table: string) => any }
  workspaceId: string
  operatorId: number | null | undefined
  status: ActiveWorkStatus
}): Promise<void> {
  if (args.operatorId == null) return
  try {
  const { data } = await args.supabase
    .from('caye_operator_messages')
    .select('id, intent')
    .eq('workspace_id', args.workspaceId)
    .eq('operator_allowlist_id', args.operatorId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(20)
  for (const row of data ?? []) {
    const work = activeWorkFromIntent(row.intent)
    if (!work || work.status === 'completed') continue
    await args.supabase
      .from('caye_operator_messages')
      .update({ intent: { ...(row.intent as IntentRecord), active_work: { ...work, status: args.status } } })
      .eq('id', row.id)
    return
  }
  } catch {
    // Lifecycle metadata must not turn a completed operator action into a
    // failed one if the audit-store update itself is temporarily unavailable.
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
