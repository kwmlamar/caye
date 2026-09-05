import 'server-only'

import { createBedrockAdapter, type BedrockAdapter } from '@/lib/domain-adapters/bedrock'
import { observeAttentionItem } from '@/lib/owner-attention'

/**
 * Friday aging digest: invoices over 30 days with nothing recorded against
 * them, oldest first, no action requested — just the list.
 *
 * Raises through the SAME caye_owner_attention + construction-ledger-cycle
 * delivery path every other producer in this codebase uses (see
 * lib/receivables-attention.ts, lib/freight-attention.ts) rather than a
 * bespoke send: one row per calendar day this runs (it only ever runs on a
 * Friday — see the cron route), keyed so a re-run the same day updates the
 * row in place instead of raising a duplicate. Actual delivery to WhatsApp
 * happens on construction-ledger-cycle's existing 30-minute cadence once
 * this subject type is in DELIVERABLE_SUBJECT_TYPES — this module only
 * raises, it never sends.
 *
 * SHIPS DISABLED BY DEFAULT. See the cron route for why.
 */
export const SUBJECT_PAYMENT_WATCHER_WEEKLY_DIGEST = 'payment_watcher_weekly_digest'

const AGE_THRESHOLD_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

type WeeklyNudgeAdapter = Pick<BedrockAdapter, 'listInvoices' | 'getInvoiceWithPayments'>

export interface WeeklyAgingNudgeResult {
  considered: number
  flagged: number
  raised: boolean
}

function daysBetween(dateStr: string | null, now: Date): number {
  if (!dateStr) return 0
  const then = new Date(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(then.getTime())) return 0
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return Math.max(0, Math.floor((today.getTime() - then.getTime()) / MS_PER_DAY))
}

export async function raisePaymentWatcherWeeklyNudge(args: {
  workspaceId: string
  deps?: {
    getAdapter?: () => WeeklyNudgeAdapter
    observe?: typeof observeAttentionItem
    now?: () => Date
  }
}): Promise<WeeklyAgingNudgeResult> {
  const getAdapter = args.deps?.getAdapter ?? createBedrockAdapter
  const observe = args.deps?.observe ?? observeAttentionItem
  const now = args.deps?.now ?? (() => new Date())

  const adapter = getAdapter()
  const asOf = now()

  const invoices = await adapter.listInvoices(args.workspaceId)
  const open = invoices.filter((inv) => inv.sentAt !== null && inv.balanceDue > 0)

  const flagged: Array<{ id: string; label: string; balanceDue: number; days: number }> = []
  for (const invoice of open) {
    const { payments } = await adapter.getInvoiceWithPayments(args.workspaceId, invoice.id)
    if (payments.length > 0) continue // "nothing recorded against them" — a part payment excludes it
    const days = daysBetween(invoice.issueDate, asOf)
    if (days > AGE_THRESHOLD_DAYS) {
      flagged.push({
        id: invoice.id,
        label: invoice.clientName?.trim() || invoice.invoiceNumber?.trim() || invoice.id,
        balanceDue: invoice.balanceDue,
        days,
      })
    }
  }
  flagged.sort((a, b) => b.days - a.days)

  const result: WeeklyAgingNudgeResult = { considered: open.length, flagged: flagged.length, raised: false }
  if (flagged.length === 0) return result

  const dateKey = asOf.toISOString().slice(0, 10)
  const total = flagged.reduce((sum, f) => sum + f.balanceDue, 0)
  const lines = flagged
    .map((f, i) => `${i + 1}. ${f.label}: $${f.balanceDue.toFixed(2)}, ${f.days} days, nothing recorded`)
    .join('\n')

  await observe({
    workspaceId: args.workspaceId,
    subjectType: SUBJECT_PAYMENT_WATCHER_WEEKLY_DIGEST,
    subjectId: dateKey,
    title: `${flagged.length} invoice${flagged.length === 1 ? '' : 's'} over 30 days with nothing recorded — $${total.toFixed(2)} total`,
    priority: 'awareness',
    nextAction: `No action needed — just the list, oldest first:\n${lines}`,
    fingerprintParts: [dateKey, flagged.map((f) => f.id).sort().join(',')],
    blockedOnOperator: false,
    resolvableAutonomously: false,
  })
  result.raised = true
  return result
}
