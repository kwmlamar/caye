import { detectInternalLeak } from '@/lib/operator-text-guard'

/**
 * Structured reading of an inbound prose message, and a deterministic
 * renderer that turns it into the paragraph an operator actually reads.
 *
 * WHY THIS EXISTS (2026-08-12)
 * lib/operator-brief.ts's prose path quoted the first 400 characters of the
 * inbound verbatim. Live, on a real B2B email from Ruslan Prakapovich
 * (Accessible Travel Solutions), Mrs. Max received:
 *
 *   Ruslan Prakapovich wrote: "Dear Karenda and Maxwell, Thank you for this
 *   very thoughtful and comprehensive list of questions. I appreciate the
 *   care you have taken to document everything clearly, both for our
 *   discussion and for your team's reference. These are all excellent
 *   questions, and several touch on important operational details that I
 *   want to make sure I address thoroughly and accurately. Rather than
 *   provide partial…"
 *
 * A salutation, thanks, a compliment, a restatement of the compliment, and a
 * subordinate clause cut mid-sentence. Zero business content. The owner
 * learned that Ruslan is polite.
 *
 * THIS IS NOT A LENGTH PROBLEM AND RAISING THE CAP DOES NOT FIX IT.
 * Business correspondence is ordered greeting → pleasantries → context →
 * ask → next steps. Prefix-truncating it is structurally guaranteed to
 * return the least informative span in the message. The ask is wherever the
 * writer put it, which is usually last.
 *
 * SPLIT OF RESPONSIBILITY. Extraction is genuinely semantic — only reading
 * comprehension separates "he's asking for group pricing" from "he's saying
 * hello". That part is an LLM call against a fixed schema. Rendering the
 * result is pure string assembly with no judgment in it, so it stays
 * deterministic and unit-tested here, exactly like the structured-form path
 * in operator-brief.ts. The model chooses the FACTS; it never chooses the
 * SHAPE of what the operator reads.
 *
 * NO PRONOUNS FOR THE CUSTOMER — same rule as operator-brief.ts. The schema
 * carries a name, never a gender.
 */

export type DigestConfidence = 'high' | 'medium' | 'low'

/**
 * The structured intermediate representation. Every field is optional
 * except `intent` and `substantive`, because a real message may genuinely
 * carry no deadline, no money, and no ask — and inventing those is worse
 * than omitting them.
 */
export interface InboundDigest {
  /** Person who wrote it, as they signed it. Null if unsigned. */
  sender: string | null
  /** Company/org they represent. Null for a private individual. */
  organization: string | null
  /** What they want, in Caye's words, one sentence. Never a quote. */
  intent: string
  /** Business stake — why the owner should care. Null when there isn't one. */
  whyItMatters: string | null
  /** Where things stand right now, one clause. */
  currentStatus: string | null
  /** The specific thing they're asking the business to do, if anything. */
  requestedAction: string | null
  /** Any date/time constraint they stated. Verbatim if they gave one. */
  deadline: string | null
  /** Money at stake, only if the message actually names or implies figures. */
  financialImpact: string | null
  /** What the business has already promised them. Null if nothing. */
  commitmentsMade: string | null
  /** Caye's recommendation. Null when the evidence doesn't support one —
   *  which is a legitimate and useful answer, not a failure. */
  recommendedAction: string | null
  /** The ONE thing the owner must decide, phrased as a question. Null when
   *  nothing needs them yet. Null is the common case for a holding note. */
  decisionNeeded: string | null
  /** How much of the above is read off the text vs inferred. */
  confidence: DigestConfidence
  /** Does this carry real business content at all? False for an
   *  acknowledgement, a "will reply properly soon", a thank-you. */
  substantive: boolean
  /**
   * Does anyone have to DO something as a result — Caye or the owner?
   *
   * SEPARATE FROM `substantive` ON PURPOSE (2026-08-12b). These were one
   * boolean until a harbour-authority notice — reduced fuel-dock hours,
   * "no action is required from operators" — proved they are two questions.
   * It carries real operational content the owner should know AND needs
   * nothing done. Collapsing the two forced that email into either a
   * decision brief or a "nothing to decide yet, I'll bring it to you when
   * the real answer lands" — and the second is a lie, because nothing more
   * is coming.
   *
   *   substantive=false                    → acknowledgement. Two lines.
   *   substantive=true,  actionNeeded=false → informational. State it, stop.
   *   substantive=true,  actionNeeded=true  → the full brief.
   */
  actionNeeded: boolean
}

/**
 * Coerce a raw tool payload into a trustworthy InboundDigest.
 *
 * Exported for tests, and deliberately strict: a model that returns the
 * empty string, the literal "null", or text carrying internal machinery
 * gets that field dropped rather than rendered. `intent` is the one
 * required field — without it there is no reading, so the whole digest is
 * discarded and the caller falls back.
 */
export function normalizeDigest(raw: Record<string, unknown>): InboundDigest | null {
  const str = (k: string): string | null => {
    const v = raw[k]
    if (typeof v !== 'string') return null
    const t = v.trim()
    if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'none') return null
    // Same reasoning as operator-brief.ts: this text reaches a phone, so a
    // field carrying internal machinery is dropped, not cleaned.
    if (detectInternalLeak(t)) {
      console.error(`[inbound-digest] internal text in field "${k}" — dropping field`)
      return null
    }
    return t
  }

  const intent = str('intent')
  if (!intent) return null

  const confidenceRaw = typeof raw.confidence === 'string' ? raw.confidence.toLowerCase() : ''
  const confidence: DigestConfidence =
    confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
      ? confidenceRaw
      : 'low'

  return {
    sender: str('sender'),
    organization: str('organization'),
    intent,
    whyItMatters: str('whyItMatters'),
    currentStatus: str('currentStatus'),
    requestedAction: str('requestedAction'),
    deadline: str('deadline'),
    financialImpact: str('financialImpact'),
    commitmentsMade: str('commitmentsMade'),
    recommendedAction: str('recommendedAction'),
    decisionNeeded: str('decisionNeeded'),
    confidence,
    // Default TRUE only when explicitly true. An extractor that omitted the
    // field is telling us nothing, and treating "unknown" as "no ask here"
    // could bury a real request.
    substantive: raw.substantive !== false,
    // Same conservative default, for the same reason — but a message with no
    // real content cannot need action, whatever the extractor said.
    actionNeeded: raw.substantive !== false && raw.actionNeeded !== false,
  }
}

/**
 * Render the digest as the body of an operator brief.
 *
 * Deterministic. Answers, in order: who is this, what do they want, why it
 * matters, what has happened, what Caye recommends, and what (if anything)
 * the owner must decide. Every part is skipped when its field is null, so a
 * thin message produces a short brief rather than a padded one.
 *
 * Returns the paragraphs; the caller assembles them with the opening line
 * and any calendar context (see operator-brief.ts).
 */
export function renderDigestBody(digest: InboundDigest): string[] {
  const who = [digest.sender, digest.organization ? `at ${digest.organization}` : null]
    .filter(Boolean)
    .join(' ')

  const paras: string[] = []

  // Who + what they want, as one sentence. The single highest-value line.
  paras.push(who ? `${who} — ${digest.intent}` : digest.intent)

  if (!digest.substantive) {
    // A holding note or a thank-you. Say which, say what happens next, stop.
    // This is the Ruslan case, and two lines is the correct length for it.
    const tail = [
      digest.currentStatus,
      digest.commitmentsMade ? `Already promised: ${digest.commitmentsMade}.` : null,
      "Nothing to decide yet — I'll bring it to you when the real answer lands.",
    ].filter(Boolean)
    paras.push(tail.join(' '))
    return paras
  }

  if (!digest.actionNeeded) {
    // Real content, nothing to do. Say what it means and close — no ask, and
    // crucially NOT the "I'll bring it when the real answer lands" line
    // above, which would promise a follow-up that is never coming.
    const tail = [
      digest.whyItMatters,
      digest.deadline ? `Timing: ${digest.deadline}.` : null,
      'Nothing needed from you — noted.',
    ].filter(Boolean)
    paras.push(tail.join(' '))
    return paras
  }

  // Why it matters + hard constraints, grouped into one scannable block.
  const stakes = [
    digest.whyItMatters,
    digest.financialImpact ? `Money on it: ${digest.financialImpact}.` : null,
    digest.deadline ? `Timing: ${digest.deadline}.` : null,
  ].filter(Boolean)
  if (stakes.length > 0) paras.push(stakes.join(' '))

  // State: what they asked for, where it stands, what's been promised.
  const state = [
    digest.requestedAction ? `They're asking: ${digest.requestedAction}.` : null,
    digest.currentStatus,
    digest.commitmentsMade
      ? `Already promised: ${digest.commitmentsMade}.`
      : 'Nothing promised on price or availability.',
  ].filter(Boolean)
  if (state.length > 0) paras.push(state.join(' '))

  // The recommendation, always marked as a position rather than a fact.
  // Low confidence gets hedged in the marker instead of being suppressed —
  // a hedged opinion is more useful to an owner than no opinion.
  if (digest.recommendedAction) {
    paras.push(
      digest.confidence === 'low'
        ? `Not certain on this one, but I'd lean toward: ${digest.recommendedAction}`
        : `My recommendation: ${digest.recommendedAction}`
    )
  }

  return paras
}

/** The single closing question, or null when nothing needs the owner. */
export function digestClosingAsk(digest: InboundDigest): string | null {
  if (!digest.substantive || !digest.actionNeeded) return null
  return digest.decisionNeeded
}
