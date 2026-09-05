import 'server-only'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { createBedrockAdapter, type BedrockAdapter } from '@/lib/domain-adapters/bedrock'
import { observeAttentionItem } from '@/lib/owner-attention'
import { resolveOperatorByPhone } from '@/lib/operator-identity'
import { gateHighRisk } from '@/lib/caye-agent/tools/high-risk-gate'
import { recordPayment } from '@/lib/caye-agent/tools/write-high/record-payment'
import type { Role, ToolContext } from '@/lib/caye-agent/tools/types'
import { detectPaymentSignal } from './detection'
import { rankInvoiceMatches } from './matching'
import type { InvoiceCandidate, PaymentSignal } from './types'

/**
 * Email payment signal -> matched proposal (or evidence-carrying no-match) ->
 * owner attention. Never writes a payment (see record-payment.ts's own rule);
 * this only stages one, exactly as if an operator had typed the same thing in
 * chat, and hands the resulting pending_action_id to Wallace over WhatsApp.
 *
 * `subject_type` is free text with no CHECK constraint — declared once here,
 * the same rule lib/receivables-attention.ts and lib/freight-attention.ts
 * document, so no second producer can key this differently.
 */
export const SUBJECT_PAYMENT_SIGNAL = 'payment_signal'

export interface ProposePaymentMatchInput {
  workspaceId: string
  subject: string | null
  body: string | null
  from: string | null
  /** Gmail message id — the durable, unique key for this one email. */
  messageId: string
  /** Gmail thread id, for the source link back to the email. */
  threadId: string
  receivedAt: string
}

export type ProposePaymentMatchOutcome =
  | { staged: false; reason: 'not_a_payment_signal' | 'outbound_direction' }
  | { staged: 'matched'; pendingActionId: string; invoiceId: string }
  | { staged: 'ambiguous'; candidateInvoiceIds: string[] }
  | { staged: 'no_match' }

type WatcherAdapter = Pick<BedrockAdapter, 'listInvoices' | 'listClients'>

function messageLink(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`
}

function paymentDate(receivedAt: string): string {
  const d = new Date(receivedAt)
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10)
}

function sourceLabel(signal: PaymentSignal): string {
  return signal.isBankSender ? 'a bank deposit alert (highest-confidence source)' : 'a client email'
}

async function resolveInvoiceCandidates(adapter: WatcherAdapter, workspaceId: string): Promise<InvoiceCandidate[]> {
  const invoices = await adapter.listInvoices(workspaceId)
  const open = invoices.filter((inv) => inv.sentAt !== null && inv.balanceDue > 0)
  if (open.length === 0) return []

  // One client list fetch, reused for every open invoice's clientEmailDomain —
  // BedrockInvoice only carries a denormalized clientName snapshot, never a
  // client id or email (see lib/domain-adapters/bedrock/types.ts), so this is
  // the only way to resolve a domain to compare against the sender's.
  const clients = await adapter.listClients(workspaceId, { limit: 200 })
  const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const domainFor = (clientName: string | null): string | null => {
    if (!clientName) return null
    const target = norm(clientName)
    const match = clients.find((c) => {
      const n = norm(c.name)
      return n && (n === target || n.includes(target) || target.includes(n))
    })
    const email = match?.email ?? null
    return email ? email.split('@')[1]?.toLowerCase() ?? null : null
  }

  return open.map((inv) => ({
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    clientName: inv.clientName,
    balanceDue: inv.balanceDue,
    clientEmailDomain: domainFor(inv.clientName),
  }))
}

async function buildToolContext(workspaceId: string): Promise<ToolContext> {
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from('workspace_ai_config')
    .select('operator_whatsapp_number')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  const phone = cfg?.operator_whatsapp_number as string | null | undefined
  const operator = phone ? await resolveOperatorByPhone(supabase, workspaceId, phone) : null

  // Cron-driven system invocations use 'founder' when no human caller is
  // known — same convention as opportunity-scan/cron/route.ts and the
  // ToolMode/Role doc comments in lib/caye-agent/tools/types.ts.
  return {
    workspaceId,
    callerRole: (operator?.role ?? 'founder') as Role,
    operatorId: operator?.id ?? null,
    requestId: randomUUID(),
    origin: 'scan',
  }
}

/**
 * Run the full detect -> match -> stage -> raise-attention pipeline for one
 * inbound Gmail message. Never throws by design — every failure path returns
 * a result rather than propagating, because this runs inline inside
 * gmail-poll's per-message loop and must never be the reason polling stops
 * (the caller also wraps this in its own try/catch as a backstop; see that
 * hook's comment for why both layers exist).
 */
export async function proposePaymentMatch(
  input: ProposePaymentMatchInput,
  deps?: { getAdapter?: () => WatcherAdapter }
): Promise<ProposePaymentMatchOutcome> {
  const signal = detectPaymentSignal({ subject: input.subject, body: input.body, from: input.from })

  if (!signal.isPaymentSignal) {
    return { staged: false, reason: signal.direction === 'outbound' ? 'outbound_direction' : 'not_a_payment_signal' }
  }

  const adapter = deps?.getAdapter?.() ?? createBedrockAdapter()
  const candidates = await resolveInvoiceCandidates(adapter, input.workspaceId)
  const match = rankInvoiceMatches(signal, candidates)
  const link = messageLink(input.threadId)
  const date = paymentDate(input.receivedAt)
  const senderLabel = signal.senderName || signal.senderEmail || 'unknown sender'

  if (match.status === 'MATCHED' && match.selection) {
    const invoice = match.selection.candidate
    const confidenceLabel = match.selection.confidence === 'EXACT' ? 'exact amount match' : 'partial payment'
    const notes =
      `Detected from ${sourceLabel(signal)}. Sender: ${senderLabel}` +
      `${signal.senderEmail ? ` <${signal.senderEmail}>` : ''}. Confidence: ${confidenceLabel}. Source: ${link}`

    const ctx = await buildToolContext(input.workspaceId)
    const gated = gateHighRisk(recordPayment)
    const result = await gated.execute(
      {
        invoice_id: invoice.id,
        amount: signal.amount as number,
        payment_date: date,
        payment_method: 'bank_transfer',
        reference_number: signal.reference ?? undefined,
        notes,
      },
      ctx
    )

    const data = result.data as { pending_action_id?: string; summary?: string } | undefined
    const pendingActionId = data?.pending_action_id ?? null
    if (!result.ok || !pendingActionId) {
      // Staging failed (e.g. no ledger connection). Nothing to confirm, and
      // nothing was written — raise it as a no-match-shaped item so the
      // evidence is not simply lost.
      await observeAttentionItem({
        workspaceId: input.workspaceId,
        subjectType: SUBJECT_PAYMENT_SIGNAL,
        subjectId: input.messageId,
        title: `${senderLabel}: $${(signal.amount as number).toFixed(2)} — could not stage a proposal`,
        priority: 'awareness',
        nextAction: `Detected but could not stage automatically: ${result.error ?? 'unknown error'}. Amount $${(signal.amount as number).toFixed(2)} from ${senderLabel}, ${date}${signal.reference ? `, ref ${signal.reference}` : ''}. Source: ${link}`,
        fingerprintParts: [signal.amount, signal.senderDomain, signal.reference, 'stage_failed'],
        blockedOnOperator: true,
        resolvableAutonomously: false,
      })
      return { staged: false, reason: 'not_a_payment_signal' }
    }

    await observeAttentionItem({
      workspaceId: input.workspaceId,
      subjectType: SUBJECT_PAYMENT_SIGNAL,
      subjectId: input.messageId,
      title: `${senderLabel}: $${(signal.amount as number).toFixed(2)} — matches invoice ${invoice.invoiceNumber ?? invoice.id} (${confidenceLabel})`,
      priority: 'decision',
      nextAction:
        `Reply to confirm — pending_action_id ${pendingActionId}. ${data?.summary ?? ''} ` +
        `Nothing has been recorded yet.`,
      fingerprintParts: [signal.amount, signal.senderDomain, invoice.id, signal.reference, pendingActionId],
      blockedOnOperator: true,
      resolvableAutonomously: false,
    })
    return { staged: 'matched', pendingActionId, invoiceId: invoice.id }
  }

  if (match.status === 'AMBIGUOUS') {
    const list = match.candidates
      .map((c) => `${c.candidate.invoiceNumber ?? c.candidate.id} ($${c.candidate.balanceDue.toFixed(2)} due)`)
      .join(', ')
    await observeAttentionItem({
      workspaceId: input.workspaceId,
      subjectType: SUBJECT_PAYMENT_SIGNAL,
      subjectId: input.messageId,
      title: `${senderLabel}: $${(signal.amount as number).toFixed(2)} — more than one possible invoice`,
      priority: 'awareness',
      nextAction:
        `More than one open invoice could match this $${(signal.amount as number).toFixed(2)} from ${senderLabel}` +
        `${signal.reference ? ` (ref ${signal.reference})` : ''}: ${list}. Tell Caye which one before anything is recorded. Source: ${link}`,
      fingerprintParts: [signal.amount, signal.senderDomain, signal.reference, match.candidates.map((c) => c.candidate.id).sort().join(',')],
      blockedOnOperator: true,
      resolvableAutonomously: false,
    })
    return { staged: 'ambiguous', candidateInvoiceIds: match.candidates.map((c) => c.candidate.id) }
  }

  // NO_MATCH — expected to be the dominant case at launch (TropiTrack's
  // current invoices are stale imports; see briefs/payment-watcher-email-
  // signals.md). Priority is deliberately 'awareness', not 'critical' —
  // unlike lib/freight-attention.ts's NO_MATCH rule, a flood of these at
  // launch marked urgent would train Wallace to ignore the channel before
  // the invoice ledger even reflects real work. Everything needed to act
  // on this later without re-hunting the inbox is carried in the item
  // itself: amount, date, sender name and domain, any reference, and the
  // source link.
  await observeAttentionItem({
    workspaceId: input.workspaceId,
    subjectType: SUBJECT_PAYMENT_SIGNAL,
    subjectId: input.messageId,
    title: `${senderLabel}: $${(signal.amount as number).toFixed(2)} — no invoice matches yet`,
    priority: 'awareness',
    nextAction:
      `No open invoice matches. Once the right invoice exists: record $${(signal.amount as number).toFixed(2)} ` +
      `received ${date} from ${senderLabel}${signal.senderDomain ? ` (${signal.senderDomain})` : ''}` +
      `${signal.reference ? `, ref ${signal.reference}` : ''}. Source: ${link}`,
    fingerprintParts: [signal.amount, signal.senderDomain, signal.reference, date],
    blockedOnOperator: true,
    resolvableAutonomously: false,
  })
  return { staged: 'no_match' }
}
