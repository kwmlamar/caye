import 'server-only'
import { createServiceClient } from '../supabase-server'

/**
 * signals.ts
 *
 * Caye's memory of a prospect, and of the pattern across prospects.
 *
 * WHY (2026-08-12)
 * Nothing recorded what a lead said. Every reply started from zero, and a
 * question like "how often does price come up?" had no answer anywhere in
 * the system — it could only be rediscovered one prospect at a time, by a
 * human reading threads. An employee who forgets every conversation the
 * moment it ends is not one.
 *
 * Two consumers, one table:
 *   - per-lead   : recentSignalsFor() feeds the reply prompt, so Caye knows
 *                  what was already covered with this person.
 *   - aggregate  : topObjections() feeds the digest, so a recurring
 *                  objection becomes visible as a pattern.
 */

export type SignalKind =
  | 'objection'
  | 'question'
  | 'intent'
  | 'disqualifier'
  | 'escalation'
  | 'outcome'

export interface RecordSignalInput {
  workspaceId: string
  leadId: string
  kind: SignalKind
  /** Short, low-cardinality, snake_case. This is the GROUP BY key. */
  label: string
  detail?: string | null
}

/**
 * Best-effort. A failure to record memory must never abort the action that
 * was being taken — losing a signal row is bad, failing to send a reply
 * because we could not write a note about it is worse.
 */
export async function recordSignal(input: RecordSignalInput): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.from('sales_lead_signals').insert({
      workspace_id: input.workspaceId,
      lead_id: input.leadId,
      kind: input.kind,
      label: input.label.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 60),
      detail: input.detail?.slice(0, 2000) ?? null,
    })
    if (error) console.error('[sales/signals] insert failed:', error.message)
  } catch (err) {
    console.error('[sales/signals] insert threw:', err)
  }
}

export interface LeadSignal {
  kind: SignalKind
  label: string
  detail: string | null
  created_at: string
}

/** Most recent first. Capped — a reply prompt does not need full history. */
export async function recentSignalsFor(leadId: string, limit = 12): Promise<LeadSignal[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('sales_lead_signals')
    .select('kind, label, detail, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('[sales/signals] read failed:', error.message)
    return []
  }
  return (data ?? []) as LeadSignal[]
}

/**
 * Plain-English phrasing per signal kind.
 *
 * Deliberately not `[${kind}] ${label}`: that shape is banned by
 * no-internal-leak-paths.test.ts, and rightly so. Bracketed internal
 * identifiers in a prompt are one careless copy away from appearing in a
 * message to a prospect, and "[objection] price_too_high" is not something
 * a human should ever receive. Same discipline as ownerNoteFor in
 * lib/caye-agent/evidence.ts.
 */
const SIGNAL_PHRASING: Record<SignalKind, string> = {
  objection: 'They pushed back on',
  question: 'They asked about',
  intent: 'Buying signal',
  disqualifier: 'Not a fit because of',
  escalation: 'Handed to Lamar over',
  outcome: 'Already happened',
}

/** Rendered into a reply prompt so Caye does not re-tread covered ground. */
export function renderSignalsBlock(signals: LeadSignal[]): string {
  if (signals.length === 0) return ''
  const lines = signals.map((s) => {
    const readable = s.label.replace(/_/g, ' ')
    const detail = s.detail ? `. ${s.detail.slice(0, 200)}` : ''
    return `- ${SIGNAL_PHRASING[s.kind]} ${readable}${detail}`
  })
  return ['WHAT YOU ALREADY KNOW ABOUT THIS PROSPECT', ...lines].join('\n')
}

export interface ObjectionCount {
  label: string
  count: number
}

/**
 * Cross-lead pattern for the digest. This is the "identifying patterns in
 * objections" capability — it is a GROUP BY, not an inference, so it cannot
 * hallucinate a trend that is not in the data.
 */
export async function topObjections(
  workspaceId: string,
  sinceISO: string,
  limit = 5
): Promise<ObjectionCount[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('sales_lead_signals')
    .select('label')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'objection')
    .gte('created_at', sinceISO)
  if (error) {
    console.error('[sales/signals] objection rollup failed:', error.message)
    return []
  }
  const counts = new Map<string, number>()
  for (const row of data ?? []) {
    const label = (row as { label: string }).label
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}
