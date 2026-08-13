/**
 * Pure guard that catches Caye's internal machinery leaking into text an
 * operator actually reads. Sibling of policy-figure-guard.ts and
 * caye-identity-guard.ts — same reasoning: the structural fix is upstream,
 * and a backstop in code is what keeps it fixed.
 *
 * WHY THIS EXISTS (2026-08-07)
 * Two leaks landed in Mrs. Max's Caye Direct thread on the same screen:
 *
 *   1. "You're welcome! Anytime. [tool_use: get_held_queue]"
 *      summarizeTurnBody (lib/caye-operator-messages.ts) renders a turn's
 *      tool_use blocks as "[tool_use: name]" markers for the audit column.
 *      isInternalOnlyBody then hides turns that are NOTHING BUT markers — but
 *      a turn carrying both text and a tool call strips to non-empty, so it
 *      rendered with the marker still glued to the end.
 *
 *   2. "Forced escalation — b2b_partnership (inbound classifier — B2B /
 *      partnership voice). Customer message excerpt: "…". Caye did not draft a
 *      substantive reply… Owner: review the thread and respond directly."
 *      That is forced-escalation.ts's `internalContext` verbatim — written for
 *      the dashboard internal note, not for a human. buildProseBrief used it
 *      as the brief body, so it went out over WhatsApp as the ping.
 *
 * Both root causes are fixed at their source. This module exists because the
 * brief is an IRREVERSIBLE channel: once a machine payload is in the owner's
 * WhatsApp, "we fixed the composer" doesn't unsend it. Same conclusion the
 * outreach work reached after an LLM ignored its own ban list — an
 * irreversible channel gets a check in code, not a note in a prompt.
 *
 * SCOPE — deliberately narrow, to stay false-positive-free. Only the exact
 * machine strings this codebase generates are matched: the tool markers
 * summarizeTurnBody emits, and the locked stem forced-escalation.ts builds.
 * Ordinary operator prose that happens to mention an escalation is NOT
 * touched — "I escalated this to you" contains none of these patterns.
 */

/** Tool markers emitted by summarizeTurnBody for the audit `body` column. */
const TOOL_MARKER_PATTERN = /\s*\[tool_use:[^\]]*\]|\s*\[tool_result\]/g

/**
 * The machine-composed stems from forced-escalation.ts's build(). These are
 * internal-note prose — a trigger enum, the classifier that fired, and an
 * instruction addressed to the operator in the third person. None of it
 * should ever reach a human-facing surface.
 */
const INTERNAL_PROSE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bForced escalation\s*—/i, label: 'forced-escalation stem' },
  { pattern: /\binbound classifier\s*—/i, label: 'classifier diagnostic' },
  { pattern: /\bCustomer message excerpt:/i, label: 'internal excerpt label' },
  {
    pattern: /\bCaye did not draft a substantive reply\b/i,
    label: 'internal handoff note',
  },
  { pattern: /\bOwner: review the thread\b/i, label: 'internal owner directive' },
  { pattern: /\bhybrid sentiment cascade\b/i, label: 'cascade diagnostic' },
  // Bracketed snake_case system tokens — outbound queue kinds
  // ("[operator_reminder]", "[dropped_confirmation]"), turn markers
  // ("[empty]"), and anything else that echoes an internal enum into prose.
  // Live in Mrs. Max's thread 2026-08-12: operatorPingLogBody's `default:`
  // branch returned `[${kind}]` for kinds it had no case for.
  //
  // Requires an underscore (or matches the one known single-word token) so
  // ordinary bracketed prose — "[see attached]", "[draft]" — is untouched.
  // Enum names are snake_case by construction; human asides are not.
  {
    pattern: /\[(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|empty)\]/,
    label: 'internal event token',
  },
  // The quiet-scan protocol token (lib/quiet-scan.ts). That module already
  // scrubs it belt-and-braces; this is the third layer, so a NEW consumer of
  // scan text that forgets to scrub fails a test instead of shipping the
  // token to a phone. It leaked once already, on 2026-08-08.
  { pattern: /\bNOTHING_TO_REPORT\b/, label: 'quiet-scan sentinel' },
]

/**
 * Human label for a non-text inbound, for any surface a person reads.
 *
 * WHY (2026-08-12b audit). Four sites interpolated the raw WhatsApp API enum
 * straight into owner-facing text — `[${message.type}]` into
 * caye_operator_messages.body (renders in Caye Direct) and into
 * unified_conversations.last_message_preview, which get_held_queue hands back
 * as `preview` for Caye to relay out loud. So an owner's held-queue readout
 * could contain the literal string "[image]". Same defect as
 * "[operator_reminder]", a different enum.
 *
 * The bracketed snake_case guard above does NOT catch these — the WhatsApp
 * types are single words with no underscore — which is exactly why the fix
 * has to be a real renderer rather than another pattern.
 *
 * Unknown types return "Attachment", never the raw type. Same rule as
 * operatorPingLogBody's default branch: an unmapped value is a gap in this
 * function, not something to echo at a customer.
 */
export function mediaPlaceholder(messageType: string | null | undefined): string {
  switch ((messageType ?? '').toLowerCase()) {
    case 'image':
      return 'Photo'
    case 'video':
      return 'Video'
    case 'audio':
    case 'voice':
    case 'ptt':
      return 'Voice note'
    case 'document':
      return 'Document'
    case 'sticker':
      return 'Sticker'
    case 'location':
      return 'Location'
    case 'contacts':
    case 'contact':
      return 'Contact card'
    default:
      return 'Attachment'
  }
}

/**
 * Returns a short reason string when `text` carries internal machinery that an
 * operator should never see, otherwise null.
 *
 * Callers that are about to SEND use this to fail loudly (log + fall back to a
 * clean string). Tests use it as the assertion that composed operator text is
 * clean, so a future composer change that reintroduces a leak fails CI rather
 * than reaching a customer's owner.
 */
export function detectInternalLeak(text: string): string | null {
  if (!text) return null

  const found: string[] = []
  if (/\[tool_use:|\[tool_result\]/.test(text)) found.push('raw tool marker')
  for (const { pattern, label } of INTERNAL_PROSE_PATTERNS) {
    if (pattern.test(text)) found.push(label)
  }

  return found.length > 0 ? `contains ${found.join(', ')}` : null
}

/**
 * Stricter sibling of detectInternalLeak for FounderHome's "Needs You" card
 * (AttentionCard.tsx) — the one surface where an escalation's internal_context
 * (mostly plain-English per evidence.ts's ownerNoteFor, but for the
 * escalate_to_team tool path it's model-generated text passed straight
 * through, see caye-reply.ts) renders on a dashboard the founder reads in
 * five seconds, not in a WhatsApp thread she can scroll past.
 *
 * detectInternalLeak's patterns are deliberately narrow (exact machine
 * strings) to stay false-positive-free across every operator-facing surface.
 * This one adds two broader, still-low-risk signals that are specific to a
 * model narrating its own tool calls — which is what actually reached this
 * card live (2026-08-11/12): a bare snake_case token ("lookup_price",
 * "group_size_below_minimum" — ordinary English essentially never contains
 * an underscore) and self-referential confidence/spec language
 * ("self-rated confidence", "Layer 2 spec"). AttentionCard falls back to a
 * category-based generic line when this returns non-null, rather than
 * rendering the raw text.
 */
export function founderBriefingLeak(text: string): string | null {
  const base = detectInternalLeak(text)
  if (base) return base

  if (/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(text)) return 'contains internal identifier (snake_case)'
  if (/\bself-rated confidence\b/i.test(text)) return 'contains confidence-model language'
  if (/\bLayer\s*\d+\b/i.test(text)) return 'contains internal spec reference'

  return null
}

/**
 * Remove tool markers from a rendered turn body, leaving the human-readable
 * text. Returns an empty string when the body was nothing but markers, which
 * is how callers detect "this turn has nothing to show a human."
 *
 * Only strips the markers — deliberately does NOT try to rewrite leaked
 * internal PROSE. A brief whose body is a machine payload has no clean
 * subset to salvage; that case is a composer bug, caught by
 * detectInternalLeak and fixed upstream rather than papered over here.
 */
export function stripToolMarkers(text: string): string {
  return text.replace(TOOL_MARKER_PATTERN, '').trim()
}
