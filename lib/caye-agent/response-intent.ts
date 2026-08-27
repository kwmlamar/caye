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
 * there is no further attempt happening this turn, so "you are on it" was a
 * promise nothing backed. Live Bimini transcripts show the failure mode that
 * phrasing invites: fake progress, an invented root cause, then an invented
 * platform escalation.
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
          'Say plainly that it did not go through. This turn already exhausted every retry available for this operation — do not say you are on it, still working on it, still trying, or will retry; nothing further is happening right now. Do not guess or invent a reason (no "backend issue", no "the system is down", no naming an internal cause) — you were not told why, only that it failed. Do not claim you notified, flagged, or escalated this to TropiTech, engineering, developers, or support unless a real tool result proves that exact action. Never ask the operator to do the failed work themselves, and never repeat raw error text.',
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
