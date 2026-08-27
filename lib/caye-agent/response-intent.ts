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
 * Classify one tool outcome into an operator-response intent plus the
 * instruction that renders it.
 *
 * WHY THE INSTRUCTION CHANGED (CAY-140)
 * The previous instruction for a generic failure told the model to say
 * "it did not go through and that you are on it." By the time this function
 * runs, `runToolWithRecovery` has already exhausted this tool's entire retry
 * budget (see MAX_ATTEMPTS in orchestrator.ts) — there is no further attempt
 * happening this turn, so "you are on it" was always a promise nothing backs.
 * Live Bimini transcripts show exactly the failure mode that phrasing
 * invites: "Still on it — one sec" followed by an invented root cause
 * ("the staging system is down") and an invented escalation ("worth flagging
 * to the TropiTech team") — none of which the tool result actually said.
 * `failed` now says the failure plainly, forbids promising further work, and
 * forbids inventing a cause or an escalation this turn never performed.
 * `enforceActionGrounding` (action-claim-guard.ts) is the code-level backstop
 * if a model does it anyway — same belt-and-braces relationship as every
 * other guard in this codebase (operator-text-guard.ts, draft-claims.ts).
 */
export function classifyToolResponse(
  status: ToolStatus | undefined,
  deferred: boolean,
  toolName?: string
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
      if (toolName === 'draft_in_inbox') {
        return {
          intent: 'failed',
          instruction:
            "Say plainly that you couldn't save it to the inbox, and that you kept the draft here. Do not guess or state why — you were not told a cause, only that it failed. Do NOT offer to send it instead, do NOT ask the operator to copy it manually, and do NOT say this has been flagged, reported, or notified to anyone else (TropiTech, engineering, support) — no such action happened.",
        }
      }
      return {
        intent: 'failed',
        instruction:
          'Say plainly that it did not go through. This turn already exhausted every retry — do not say you are on it, still working on it, still trying, or will retry; nothing further is happening right now. Do not guess or invent a reason (no "backend issue", no "the system is down", no naming any internal cause) — you were not told why, only that it failed. Do not say you notified, flagged, or escalated this to TropiTech, engineering, or any other team — you have no way to do that and no record that it happened. Never ask the operator to do it themselves, and never repeat raw error text.',
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
      if (toolName === 'draft_in_inbox') {
        return {
          intent: 'blocked',
          instruction:
            'The requested email draft is blocked or uncertain. Preserve the completed draft text. Do NOT retry blindly, do NOT offer to send it instead, and do not turn this into a manual-copy request.',
        }
      }
      return {
        intent: 'blocked',
        instruction: 'A connection needs re-authorising. Say what is disconnected in plain words and offer to walk them through reconnecting.',
      }
  }
}
