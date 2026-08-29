import type { ToolStatus } from './tools/result'

/**
 * response-intent.ts
 *
 * CAY-140: the vocabulary for what an operator-facing reply IS, independent
 * of how much prose the model uses to say it. A tool outcome is the one
 * place in this codebase where that shape is known with certainty before any
 * model text exists — a write either committed, staged, or didn't — so this
 * is where intent is derived and attached to the instruction the model
 * receives, instead of being left for the model to infer from a raw error.
 *
 * This does NOT replace the attention triage tiers (CRITICAL / DECISION /
 * AWARENESS / ROUTINE / NOISE, defined in modes/back-office.ts's
 * autonomyBlock). Those answer "does this need surfacing at all, and how
 * urgently." ResponseIntent answers a different question: "given that this
 * IS being said, what shape of statement is it." The two compose — a
 * DECISION-tier item is usually rendered as needs_decision or
 * approval_required; a ROUTINE one as completed or result.
 *
 * CAY-139 composition note: draft_in_inbox failures are intentionally handled
 * by orchestrator.ts before this generic classifier because their error_code
 * distinguishes deterministic rejection from genuinely ambiguous provider
 * state. Flattening those outcomes back to ToolStatus here would undo #142's
 * evidence model.
 */
export type ResponseIntent =
  | 'completed'
  | 'result'
  | 'updated'
  | 'blocked'
  | 'failed'
  | 'needs_decision'
  | 'needs_clarification'
  | 'warning'
  | 'status'
  | 'approval_required'

export interface ToolResponseClassification {
  intent: ResponseIntent
  /** Plain-language instruction for the model, derived from the outcome. */
  instruction: string
}

/**
 * Classify one generic tool outcome into an operator-response intent plus the
 * instruction that renders it.
 *
 * WHY THE INSTRUCTION CHANGED (CAY-140)
 * The previous instruction for a generic failure told the model to say
 * "it did not go through and that you are on it." By the time this function
 * runs, `runToolWithRecovery` has already exhausted this tool's retry budget —
 * there is no further retry of THAT SAME operation happening automatically,
 * so "you are on it" was a promise nothing backed. Live Bimini transcripts
 * show the failure mode that phrasing invites: fake progress, an invented
 * root cause, then an invented platform escalation.
 *
 * 2026-08-28 follow-up: exhausting one operation is not the same thing as
 * failing the operator's whole objective. The previous wording said "nothing
 * further is happening right now," which encouraged the model to abort a
 * multi-part objective even when independent diagnostics, recovery actions,
 * or other useful subgoals were still available. Failures are now explicitly
 * local: the identical call is done for this turn unless a distinct recovery
 * changes its preconditions, while the rest of the objective stays live.
 *
 * Real operator/owner messaging is different: send_operator_message and
 * escalate_to_owner can genuinely reach people in the workspace. The ban
 * below is therefore only about inventing TropiTech/engineering/support-side
 * escalation that no tool performed.
 */
export function classifyToolResponse(
  status: ToolStatus | undefined,
  deferred: boolean,
  _toolName?: string
): ToolResponseClassification | null {
  if (deferred) {
    return {
      intent: 'completed',
      instruction:
        'Saved. Confirm it is done and mention only that the calendar will catch up shortly. Do not ask the operator to record anything.',
    }
  }

  switch (status) {
    case 'SUCCESS':
    case undefined:
      return null

    case 'FAILED_RETRYABLE':
    case 'FAILED_PERMANENT':
      return {
        intent: 'failed',
        instruction:
          'Say plainly that this specific operation did not go through. Its normal retry budget is exhausted, so do not immediately repeat the identical call, and do not say you are on it, still working on it, still trying, or will retry unless a separate action in this turn actually changes the conditions. IMPORTANT: this failure is local to this operation, not a reason to abandon the operator\'s whole objective. Continue any other independently achievable parts of the request. If a distinct diagnostic or recovery capability is available, relevant, and within your authority, use it; if that changes the conditions, resume the blocked objective. If no available capability can diagnose or recover it, state exactly what remains blocked and what useful work is still preserved. Do not guess or invent a reason (no "backend issue", no "the system is down", no naming an internal cause) unless evidence actually established it. Do not name internal tool identifiers in the operator-facing reply; describe the business action in plain English. Do not claim you notified, flagged, or escalated this to TropiTech, engineering, developers, or support unless a real tool result proves that exact action. Never ask the operator to do the failed work themselves, never repeat raw error text, and never erase successful or still-actionable parts of a multi-step objective just because one operation failed.',
      }

    case 'NOT_FOUND':
      return {
        intent: 'needs_clarification',
        instruction: 'The record was not found. Ask which one they meant rather than guessing.',
      }

    case 'CONFLICT':
      return {
        intent: 'warning',
        instruction: 'This already exists. Say so and confirm the existing one instead of creating a second.',
      }

    case 'NEEDS_HUMAN':
      return {
        intent: 'blocked',
        instruction: 'A connection needs re-authorising. Say what is disconnected in plain words and offer to walk them through reconnecting.',
      }
  }
}
