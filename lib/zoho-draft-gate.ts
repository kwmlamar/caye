/**
 * Is save-as-draft proven safe on this deployment?
 *
 * Pure, so it unit-tests without server-only deps.
 *
 * WHY A GATE AND NOT A COMMENT
 * createZohoReplyDraft asks Zoho to save rather than send by passing
 * `mode: "draft"` to the same /messages endpoint that sends. That flag has
 * never been verified against the live API. If Zoho ignores it, the call
 * does not fail loudly — it delivers a half-finished reply to a real guest,
 * in the owner's name, with no way to take it back. The helper has carried a
 * "VERIFY BEFORE WIRING TO PRODUCTION" warning in its docstring since it was
 * written, and that warning did what docstring warnings do, which is nothing.
 *
 * So the check lives in code. An irreversible channel gets a gate, not a
 * note — the same conclusion reached on 2026-07-31 when the front-desk model
 * ignored its own prompt-level ban list 7 times out of 31.
 *
 * Flipping the flag is a one-time act performed by scripts/verify-zoho-draft.ts,
 * which drafts to an address the founder controls and makes a human confirm
 * where it actually landed. Nothing else may set it.
 */

/** platform_settings key holding the verification result. */
export const ZOHO_DRAFT_VERIFIED_KEY = 'zoho_draft_mode_verified'

export interface DraftGateResult {
  allowed: boolean
  /** Operator-facing explanation when blocked. Never internal jargon. */
  reason?: string
}

/**
 * `setting` is the raw platform_settings value. Only the exact string 'true'
 * opens the gate: a missing row, null, 'false', or anything unrecognised all
 * fail closed. Fail-closed matters more here than almost anywhere else in the
 * codebase — the cost of a wrongly-closed gate is that Caye says "I can't
 * draft into your inbox yet", which is exactly what she says today.
 */
export function checkZohoDraftGate(setting: unknown): DraftGateResult {
  if (setting === true || setting === 'true') return { allowed: true }
  return {
    allowed: false,
    reason:
      "I can't write drafts into your inbox yet — that path hasn't been safety-checked on this " +
      'account. Lamar has to run the one-time verification first. Until then I can write the ' +
      'text here for you to paste.',
  }
}
