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

/**
 * Human-readable label for a CayeAutoReply EscalationCategory
 * ('gap' | 'policy' | 'knowledge' | 'sensitive', defined in caye-reply.ts —
 * not imported here since that module pulls in server-only/Anthropic deps
 * this file is deliberately kept free of; the union is duplicated as a
 * plain string type instead).
 *
 * WHY (Ruslan Prakapovich, 2026-08-17/CAY-12): applyAutosendGate's held-reply
 * path used to write `(would have escalated: ${decision.category})` straight
 * into the operator ping — "Ruslan Prakapovich came in — Thread is held for
 * a human — Caye did not reply (would have escalated: sensitive)." That
 * `sensitive` is the raw routing enum, not prose. The same category also
 * used to land in human_agent_reason via lib/whatsapp/escalation.ts's
 * "Escalation (category): " prefix (now dropped there entirely) — this is
 * the one place a category is translated to something an owner reads.
 */
export function escalationCategoryLabel(
  category: 'gap' | 'policy' | 'knowledge' | 'sensitive'
): string {
  switch (category) {
    case 'gap':
      return "something Caye doesn't have the tools to do"
    case 'policy':
      return 'a call only the owner can make'
    case 'knowledge':
      return 'something outside what Caye knows about the business'
    case 'sensitive':
      return 'a sensitive or commercial matter'
  }
}

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
  // The exact evidence-gate reason codes from lib/caye-agent/evidence.ts's
  // DispositionResult.reasons. ownerReasonLabelFor/ownerNoteFor translate
  // these before they reach human_agent_reason or a drafted note — but
  // "Pam Ott came in — availability_claim_unverified. Want me to take a
  // first pass, or you got this one?" (2026-08-17) shipped straight from
  // this exact machine code once already, via a caller that read
  // evidenceVerdict.reasons[0] directly instead of going through the label
  // function. Closed vocabulary, not a general snake_case scan — see
  // founderBriefingLeak below for the broader dashboard-only version.
  {
    pattern:
      /\b(?:availability_claim_unverified|quote_without_database_price|high_stakes_claim_without_verified_context|model_reported_uncertainty|owner_followup_requested)\b/,
    label: 'evidence-gate reason code',
  },
  // applyAutosendGate's held-reply reason used to say "(would have
  // escalated: sensitive)", then later "(would have escalated: a sensitive
  // or commercial matter)" once the raw enum was translated to prose — both
  // are routing-engine narration, not a business reason a human would say
  // (Ruslan Prakapovich, CAY-12 follow-up). Root-fixed to drop the
  // "would have escalated" framing entirely; this catches the whole shape,
  // translated suffix or not, if it's ever reintroduced.
  { pattern: /\bwould have escalated:/i, label: 'routing-engine narration' },
  // The "Escalation (category): " prefix lib/whatsapp/escalation.ts used to
  // write into human_agent_reason, read unstripped by lib/data/mobile.ts and
  // app/api/caye/chat/route.ts. Root-fixed to stop writing it (CAY-12); kept
  // here in case a future caller reintroduces the shape before it reaches
  // one of those readers.
  { pattern: /\bEscalation \([a-z_]+\):/i, label: 'raw escalation category prefix' },
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
 * Does `text` bare-name one of Caye's own tools — "should I stage it as a
 * send_reply?" — to the operator?
 *
 * WHY THIS EXISTS (2026-08-17, Pam Ott incident)
 * Deciding between staging a customer send and filing an external email
 * draft, the model asked the operator: "do you want this drafted into her
 * Drafts folder..., or should I stage it as a send_reply?" — reaching for
 * its own tool's internal name mid-sentence instead of describing the
 * outcome. `detectInternalLeak` didn't catch it: that guard's patterns are
 * exact machine-composed strings and bracketed `[snake_case]` tokens, and
 * this was neither — a bare identifier inside otherwise-ordinary prose.
 * `founderBriefingLeak` already catches ANY bare snake_case token, but it's
 * tuned for a dashboard card a founder reads for five seconds, where that
 * breadth is safe; a live back-and-forth conversation is more likely to
 * legitimately contain an operator-chosen code or reference number with an
 * underscore in it, so this is deliberately narrower — a closed vocabulary
 * of Caye's OWN real tool names, not "any snake_case", so there is no
 * false-positive risk against ordinary operator prose. Callers pass the
 * live tool list (TOOL_REGISTRY names) rather than this module importing
 * it directly, keeping this file's own dependency surface tool-free.
 */
export function detectToolNameLeak(text: string, toolNames: readonly string[]): string | null {
  if (!text) return null
  for (const name of toolNames) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return name
  }
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
