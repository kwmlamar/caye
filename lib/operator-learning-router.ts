import 'server-only'
import { prefilterOperatorMessage } from './operator-learning/prefilter'
import { classifyOperatorMessage } from './operator-learning/classify'
import { decideRouting } from './operator-learning/route-decision'
import { recordLearningAudit, alreadyProcessed } from './operator-learning/audit'
import { holdBusinessFactCandidate, holdGenericNotice } from './operator-learning/hold'
import { writeBusinessFact } from './operator-learning/writers/business-fact-writer'
import { writePricing } from './operator-learning/writers/pricing-writer'
import { writeContact } from './operator-learning/writers/contact-writer'
import { writeAvailabilityRecurring, writeAvailabilityDate } from './operator-learning/writers/availability-writer'
import type { ClassificationResult, Destination } from './operator-learning/schema'
import type { Role } from './caye-agent/tools/types'
import type { WriteOutcome } from './operator-learning/writers/types'

/**
 * lib/operator-learning-router.ts
 *
 * The deterministic learning pipeline described in the architecture audit's
 * follow-up: an authorized operator's statement/correction is captured
 * whether or not the conversational back-office agent happens to call a
 * write tool in the same turn.
 *
 * Pipeline: authority resolved (by the caller — see below) → idempotency
 * check → deterministic prefilter → structured semantic classifier → schema
 * validation → deterministic routing decision → target-specific write OR
 * candidate/no-op → audit event.
 *
 * AUTHORITY: this function does not re-derive the operator's role from the
 * phone number itself — the caller (the operator webhook) already resolved
 * it from operator_allowlist exactly the same way tool execution does, and
 * passes it in as `callerRole`. decideRouting() is the single deterministic
 * gate on whether that role may write live (see its own doc comment) — a
 * future caller cannot bypass it by passing a fabricated role, because this
 * function is only ever reachable from the operator webhook's own resolved
 * `operator` object, never from user input.
 *
 * FAILURE POSTURE: every stage from classification onward is wrapped so a
 * failure produces an 'error' audit row and returns — never a partial
 * write, never invented content, never a thrown error. The caller (the
 * webhook) invokes this WITHOUT awaiting it (`.catch()`, same convention as
 * maybeSuggestBusinessFacts), so a bug here structurally cannot affect the
 * operator's reply — but this function is defensively safe on its own
 * terms too, since it's also called directly by tests and could be called
 * synchronously by a future caller.
 */
export async function routeOperatorLearningCorrection(input: {
  workspaceId: string
  operatorId: number | null
  operatorRole: Role
  operatorText: string
  previousCayeText: string | null
  sourceMessageId: string | null
  sourceConversationId: string | null
}): Promise<void> {
  // Rule 6, structurally: this function is only ever invoked from the
  // operator webhook with an operator_allowlist-resolved role. There is no
  // "customer" role in the Role union at all — a customer message cannot
  // reach this function's type signature, let alone its logic.
  if (!input.operatorId) {
    await recordLearningAudit(auditBase(input, null, 'no_op', null, null, null, 'no resolved operator id'))
    return
  }

  if (await alreadyProcessed(input.workspaceId, input.sourceMessageId)) {
    return
  }

  const prefilter = prefilterOperatorMessage(input.operatorText)
  if (!prefilter.worthClassifying) {
    await recordLearningAudit(auditBase(input, null, 'no_op', null, null, null, prefilter.reason))
    return
  }

  const classified = await classifyOperatorMessage({
    operatorText: input.operatorText,
    prefilter,
    previousCayeText: input.previousCayeText,
    workspaceId: input.workspaceId,
  })

  if (!classified.ok) {
    await recordLearningAudit(auditBase(input, null, 'error', null, null, null, classified.reason))
    return
  }

  const classification = classified.value
  if (!classification.learnable) {
    await recordLearningAudit(auditBase(input, classification, 'no_op', null, null, null, classification.rationale))
    return
  }

  const plan = decideRouting({ classification, callerRole: input.operatorRole })

  if (plan.action === 'no_op') {
    await recordLearningAudit(auditBase(input, classification, 'no_op', null, null, null, plan.reason))
    return
  }

  if (plan.action === 'candidate') {
    await surfaceCandidate(input, classification, plan.destination, plan.reason)
    return
  }

  // plan.action === 'attempt_write'
  let outcome: WriteOutcome
  try {
    outcome = await dispatchWrite(plan.destination, classification, input)
  } catch (err) {
    outcome = { decision: 'error', reason: `writer threw: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (outcome.decision === 'candidate') {
    await surfaceCandidate(input, classification, plan.destination, outcome.reason)
    return
  }

  if (outcome.decision === 'written' || outcome.decision === 'superseded_and_written') {
    await recordLearningAudit(
      auditBase(input, classification, outcome.decision, outcome.targetTable, outcome.targetRecordId, outcome.supersededRecordId, outcome.reason)
    )
    return
  }

  // 'error' or 'no_op' from the writer itself (e.g. contact already on allowlist).
  await recordLearningAudit(auditBase(input, classification, outcome.decision, null, null, null, outcome.reason))
}

async function dispatchWrite(
  destination: Destination,
  classification: ClassificationResult,
  input: { workspaceId: string; operatorRole: Role }
): Promise<WriteOutcome> {
  switch (destination) {
    case 'business_fact':
      return writeBusinessFact({ workspaceId: input.workspaceId, callerRole: input.operatorRole, classification })
    case 'pricing':
      return writePricing({ workspaceId: input.workspaceId, classification })
    case 'contact':
      return writeContact({ workspaceId: input.workspaceId, callerRole: input.operatorRole, classification })
    case 'availability_recurring':
      return writeAvailabilityRecurring({ workspaceId: input.workspaceId, callerRole: input.operatorRole, classification })
    case 'availability_date':
      return writeAvailabilityDate({ workspaceId: input.workspaceId, callerRole: input.operatorRole, classification })
    case 'none':
      return { decision: 'error', reason: 'attempt_write plan with destination=none — should be unreachable' }
  }
}

async function surfaceCandidate(
  input: {
    workspaceId: string
    operatorId: number | null
    operatorRole: Role
    sourceMessageId: string | null
    sourceConversationId: string | null
    operatorText: string
  },
  classification: ClassificationResult,
  destination: Destination,
  reason: string
): Promise<void> {
  let targetRecordId: string | null = null
  if (destination === 'business_fact') {
    const held = await holdBusinessFactCandidate({
      workspaceId: input.workspaceId,
      conversationId: input.sourceConversationId,
      classification,
    })
    targetRecordId = held.candidateId
  } else if (destination !== 'none') {
    await holdGenericNotice({ workspaceId: input.workspaceId, destination, classification, reason })
  }

  await recordLearningAudit(
    auditBase(
      input,
      classification,
      'candidate',
      destination === 'business_fact' ? 'business_fact_candidates' : null,
      targetRecordId,
      null,
      reason
    )
  )
}

function auditBase(
  input: {
    workspaceId: string
    operatorId: number | null
    operatorRole: Role
    sourceMessageId: string | null
    sourceConversationId: string | null
    operatorText: string
  },
  classification: ClassificationResult | null,
  decision: 'written' | 'superseded_and_written' | 'candidate' | 'no_op' | 'rejected' | 'error',
  targetTable: string | null,
  targetRecordId: string | null,
  supersededRecordId: string | null,
  reason: string
) {
  return {
    workspaceId: input.workspaceId,
    sourceOperatorId: input.operatorId,
    sourceOperatorRole: input.operatorRole,
    sourceMessageId: input.sourceMessageId,
    sourceConversationId: input.sourceConversationId,
    sourceExcerpt: input.operatorText,
    classification,
    decision,
    targetTable,
    targetRecordId,
    supersededRecordId,
    reason,
  }
}
