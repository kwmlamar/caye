import crypto from 'node:crypto'
import type { FreightWorkflowRecord } from './workflow'

export type FreightOwnerIntent =
  | 'handle'
  | 'inspect_need'
  | 'find_evidence'
  | 'prepare'
  | 'show'
  | 'send'
  | 'hold'
  | 'reject_evidence'
  | 'list_pending'
  | 'check_sent'
  | 'unknown'

export interface FreightApprovalBinding {
  workspaceId: string
  workflowId: string
  artifactId: string
  artifactVersion: string
  recipient: string
  emailThreadId: string
  actorOperatorId: number
  approvedAt: string
}

export interface FreightReferent {
  workflow: FreightWorkflowRecord
  providerLabel: string
  recipient: string | null
  emailThreadId: string | null
  artifactVersion: string | null
}

const normalized = (value: string) => value.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim()

export function classifyFreightOwnerIntent(text: string): FreightOwnerIntent {
  const t = normalized(text)
  if (/\b(dont|do not|hold|wait)\b.*\b(send|email)\b|\bnot yet\b/.test(t)) return 'hold'
  if (/\b(wrong receipt|other receipt|different receipt|wrong home depot)\b/.test(t)) return 'reject_evidence'
  if (/\b(send it|send that|email it|send the (document|freight))\b/.test(t)) return 'send'
  if (/\b(show me|show it|let me see|review it)\b/.test(t)) return 'show'
  if (/\b(make|prepare|create)\b.*\b(document|invoice|freight)\b/.test(t)) return 'prepare'
  if (/\b(find|look for|locate)\b.*\b(receipt|invoice|purchase)\b/.test(t)) return 'find_evidence'
  if (/\b(what does|what did)\b.*\b(need|want|ask)|\bwhat.*need\b/.test(t)) return 'inspect_need'
  if (/\b(whats|what is|show|list)\b.*\b(waiting|pending)\b.*\bfreight\b/.test(t)) return 'list_pending'
  if (/\b(did you|was it|have you)\b.*\b(send|sent|email)\b/.test(t)) return 'check_sent'
  if (/\b(handle|take care of|deal with)\b.*\b(freight|king ocean|email|one|thing)\b/.test(t)) return 'handle'
  return 'unknown'
}

function referentText(r: FreightReferent): string {
  const req = r.workflow.request
  return normalized([r.providerLabel, req.freightProvider, req.senderName, req.senderEmail, req.dockReceiptNumber, req.shipmentReference].filter(Boolean).join(' '))
}

export function resolveFreightReferent(input: {
  workspaceId: string
  text: string
  referents: FreightReferent[]
  activeWorkflowId?: string | null
}): { kind: 'resolved'; referent: FreightReferent } | { kind: 'ambiguous'; options: FreightReferent[] } | { kind: 'none' } {
  const candidates = input.referents.filter(r => r.workflow.workspaceId === input.workspaceId)
  if (!candidates.length) return { kind: 'none' }
  const t = normalized(input.text)
  const generic = /\b(that|it|one|thing|freight|email|send|show|handle|take care)\b/.test(t)
  const scored = candidates.map(referent => {
    let score = 0
    const haystack = referentText(referent)
    const req = referent.workflow.request
    for (const token of t.split(/[^a-z0-9@.-]+/).filter(x => x.length >= 3)) if (haystack.includes(token)) score += 2
    if (req.dockReceiptNumber && t.includes(normalized(req.dockReceiptNumber))) score += 8
    if (input.activeWorkflowId === referent.workflow.id && generic) score += 4
    if (referent.workflow.status === 'READY_FOR_APPROVAL' && /\b(send|show|it|that)\b/.test(t)) score += 2
    return { referent, score }
  }).sort((a, b) => b.score - a.score)
  if (scored[0].score > 0 && (!scored[1] || scored[0].score > scored[1].score)) return { kind: 'resolved', referent: scored[0].referent }
  if (candidates.length === 1) return { kind: 'resolved', referent: candidates[0] }
  const plausible = scored.filter(x => x.score === scored[0].score).map(x => x.referent)
  return { kind: 'ambiguous', options: plausible.length > 1 ? plausible : candidates }
}

export function artifactVersion(input: { artifactId: string; bytesHash?: string | null; updatedAt?: string | null }): string {
  return crypto.createHash('sha256').update([input.artifactId, input.bytesHash ?? '', input.updatedAt ?? ''].join(':')).digest('hex')
}

export function bindFreightApproval(input: Omit<FreightApprovalBinding, 'approvedAt'> & { approvedAt?: string }): FreightApprovalBinding {
  return { ...input, approvedAt: input.approvedAt ?? new Date().toISOString() }
}

export function validateFreightApproval(binding: FreightApprovalBinding, current: {
  workspaceId: string
  workflowId: string
  artifactId: string
  artifactVersion: string
  recipient: string
  emailThreadId: string
  actorOperatorId: number
  conflictingInstructionAfter?: string | null
  maxAgeMs?: number
  now?: string
}): { valid: true } | { valid: false; reason: string } {
  if (binding.workspaceId !== current.workspaceId || binding.workflowId !== current.workflowId) return { valid: false, reason: 'workflow_changed' }
  if (binding.artifactId !== current.artifactId || binding.artifactVersion !== current.artifactVersion) return { valid: false, reason: 'artifact_changed' }
  if (binding.recipient !== current.recipient || binding.emailThreadId !== current.emailThreadId) return { valid: false, reason: 'delivery_target_changed' }
  if (binding.actorOperatorId !== current.actorOperatorId) return { valid: false, reason: 'approval_actor_changed' }
  if (current.conflictingInstructionAfter && new Date(current.conflictingInstructionAfter).getTime() > new Date(binding.approvedAt).getTime()) return { valid: false, reason: 'newer_conflicting_instruction' }
  const maxAge = current.maxAgeMs ?? 30 * 60_000
  if (new Date(current.now ?? new Date().toISOString()).getTime() - new Date(binding.approvedAt).getTime() > maxAge) return { valid: false, reason: 'approval_stale' }
  return { valid: true }
}

export function freightOwnerSummary(referent: FreightReferent): string {
  const w = referent.workflow
  const req = w.request
  const selected = w.candidates.find(c => c.evidence.id === w.selectedEvidenceId)?.evidence
  const provider = req.freightProvider || referent.providerLabel || 'The freight provider'
  const dock = req.dockReceiptNumber ? ` for dock receipt ${req.dockReceiptNumber}` : ''
  if (w.status === 'SENT') return `Sent ${provider} the freight document${dock}.`
  if (w.status === 'NO_MATCH') return `${provider} needs a freight document${dock}, but I don't have purchase evidence I can trust yet.`
  if (w.status === 'AMBIGUOUS') return `I found more than one possible purchase record${dock}. I need you to tell me which receipt to use.`
  if (!selected) return `${provider} needs a freight document${dock}. I still need the purchase receipt.`
  const vendor = selected.vendor || 'purchase'
  const total = selected.total == null ? '' : ` for ${selected.currency ? `${selected.currency} ` : '$'}${selected.total.toFixed(2)}`
  if (w.status === 'READY_FOR_APPROVAL') return `I found the ${vendor} receipt${total}${dock ? ` tied to${dock.replace(' for', '')}` : ''}. I made the freight document. Want me to send it?`
  return `I found the ${vendor} receipt${total}${dock ? ` tied to${dock.replace(' for', '')}` : ''}. I can make the freight document.`
}

export function ambiguousFreightQuestion(options: FreightReferent[]): string {
  const labels = options.slice(0, 3).map(o => o.workflow.request.dockReceiptNumber || o.workflow.request.freightProvider || o.providerLabel).filter(Boolean)
  return labels.length ? `Which one do you mean: ${labels.join(' or ')}?` : 'Which freight request do you mean?'
}
