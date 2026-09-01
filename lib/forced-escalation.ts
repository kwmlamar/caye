/**
 * Layer 1 of the confidence model (#57).
 *
 * Deterministic forced-escalation triggers. Run BEFORE the front-desk LLM
 * call — when any trigger fires we synthesize an `escalate` decision and
 * skip the model entirely. Caye doesn't get to "try" on these; the safety
 * net is that the keyword/classifier shape alone is enough to know we need
 * the human.
 *
 * Triggers (v1):
 *   - B2B / partnership / commercial-terms (sensitive → owner). Locked
 *     2026-06-06 — Caye does not negotiate.
 *   - Complaint sentiment (policy → owner, empathy template).
 *   - Refund / cancellation-with-money (policy → owner, neutral template).
 *   - Custom / private / special / exception language (policy → owner).
 *
 * Owner-taught constraints (e.g. "bring Full Bimini bookings to me") are NOT
 * hardcoded here — they live in caye_standing_rules and are evaluated by
 * lib/standing-rules.ts, after these triggers, so that platform-level safety
 * always outranks a per-workspace rule. The Full Bimini trigger briefly lived
 * here (2026-08-08) and was replaced by a data row the same day; see
 * briefs/standing-rules-plan.md for why "the hardcode can be deleted" was the
 * acceptance test for that design.
 *
 * The catalog/blackout/group-size triggers in the spec are enforced inside
 * the tool layer (lookup_price, check_availability already short-circuit
 * those cases); they don't need a pre-LLM check.
 *
 * Per-trigger empathy templates are controlled enum strings — not LLM-
 * generated — so they don't cost tokens and don't drift between calls.
 *
 * Hybrid sentiment cascade (Haiku second-pass) lives in `detectSubtleComplaint`
 * — called by the front-desk layer when this module returns null but the
 * inbound has weak emotional signals. Cascade pattern matches #47.
 */

import 'server-only'
import type { InboundCategory } from './inbound-classifier'
import { loggedMessagesCreate } from './llm-telemetry'
import { buildCustomerRecap } from './operator-brief'

export type ForcedTrigger =
  | 'b2b_partnership'
  | 'complaint'
  | 'refund'
  | 'custom_request'
  /** Owner-taught constraint from caye_standing_rules — not a platform
   *  trigger. Built in lib/standing-rules.ts, evaluated after the hardcoded
   *  triggers below (platform safety outranks a workspace rule). */
  | 'standing_rule'

export interface ForcedEscalation {
  trigger: ForcedTrigger
  category: 'gap' | 'policy' | 'knowledge' | 'sensitive'
  routeTo: 'owner' | 'founder' | 'both'
  customerFacingMessage: string
  internalContext: string
  /** One-line operator-friendly description for the WhatsApp ping. Goes into
   *  the caye_urgent_hold template's reason placeholder. Designed to read
   *  cleanly when truncated to ~80 chars — leads with the trigger label, then
   *  the customer's actual ask. Distinct from internalContext which is the
   *  verbose handoff written for the dashboard internal note. */
  pingSummary: string
}

// ── Per-trigger empathy templates ──────────────────────────────────────────
// Locked strings. Controlled enum — never LLM-generated, so we don't pay
// tokens and the wording can't drift. Each one ends in a vague handoff line
// per the customer-facing rules in escalate_to_team.
const TEMPLATES: Record<ForcedTrigger, string> = {
  b2b_partnership:
    "Thanks for reaching out — let me get this in front of the team and we'll be back to you shortly.",
  complaint:
    "I'm sorry you had that experience — let me get this to the team and we'll make it right.",
  refund:
    "Thanks for letting me know — checking with the team on this and we'll get back to you shortly.",
  custom_request:
    "Thanks for the details — let me check on this with the team and circle back shortly.",
  // Standing-rule escalations build their own customer-facing string from a
  // locked template in lib/standing-rules.ts; this entry exists so the
  // Record stays exhaustive for any shared code path that indexes by trigger.
  standing_rule:
    "Thanks for reaching out — let me get this in front of the team and we'll be back to you shortly.",
}

/** Operator-friendly trigger labels for the WhatsApp ping. Short enough that
 *  the trigger label + customer-message excerpt both fit in the ~80-char
 *  template placeholder without truncating the actually-useful customer text. */
const PING_LABELS: Record<ForcedTrigger, string> = {
  b2b_partnership: 'B2B inquiry',
  complaint: 'Complaint',
  refund: 'Refund request',
  custom_request: 'Custom request',
  standing_rule: 'Your rule',
}

// ── Keyword patterns ───────────────────────────────────────────────────────
// Refund pattern looks for refund/money-back language. NOT bundled into the
// complaint classifier even though it overlaps — refund gets a neutral
// acknowledge, complaint gets an empathy line. Different template needs
// different detection paths.
// Deliberately request-shaped, not a bare "refund" match — "is a refund offered
// if the port stop is cancelled?" is a policy question, not a refund ask, and
// used to false-fire this trigger (Karin Roberts thread, 2026-08-06).
const REFUND_PATTERN =
  /\b(money back|chargeback|charge back|reverse the charge|get my money|my deposit back|return my deposit|i want my money|i(?:'d| would)? (?:like|want|need) (?:a |my )?refund|give me (?:a |my )?refund|issue (?:a |my )?refund|process(?:ing)? a refund)\b/i

// "Custom / private / special / exception" pattern — catches off-menu
// commercial asks even when classifyInbound returns 'general_question'.
// Words alone aren't enough (some are common: "special offer"); we want
// these words used as request modifiers, not casual adjectives.
const CUSTOM_REQUEST_PATTERN =
  /\b(custom (?:trip|tour|booking|arrangement|package|itiner)|private (?:tour|trip|charter|booking)|special (?:arrangement|request|accommodation|booking)|make an exception|exception to|off[- ]menu|off the menu|bespoke|tailored)\b/i


/**
 * Check the inbound for Layer 1 triggers. Returns the highest-priority
 * forced escalation, or null when no trigger fires.
 *
 * Priority order: complaint > b2b > refund > custom_request. Complaint
 * wins because the empathy template matters most when the customer is
 * upset. B2B beats refund because the routing implications are different
 * (sensitive vs policy). Owner-taught standing rules are evaluated by the
 * caller AFTER this returns null — platform safety outranks a workspace rule.
 *
 * `classifierCategory` comes from classifyInbound() — we re-use its
 * complaint / b2b decisions instead of re-running keyword detection here.
 */
export function detectForcedEscalation(
  body: string,
  classifierCategory: InboundCategory | null
): ForcedEscalation | null {
  if (classifierCategory === 'complaint') {
    return build('complaint', 'policy', 'owner', body)
  }
  if (classifierCategory === 'b2b_partnership') {
    return build('b2b_partnership', 'sensitive', 'owner', body)
  }
  if (REFUND_PATTERN.test(body)) {
    return build('refund', 'policy', 'owner', body)
  }
  if (CUSTOM_REQUEST_PATTERN.test(body)) {
    return build('custom_request', 'policy', 'owner', body)
  }
  return null
}

// Plain-English lead sentence per trigger — no "forced escalation",
// "inbound classifier", "controlled template". This is what a founder
// reads in the Inbox handoff card, so it has to read like Caye
// explaining herself, not a log line. See humanEscalationNote below for
// how it's assembled with the rest of the note.
const TRIGGER_REASON: Record<ForcedTrigger, string> = {
  b2b_partnership: "This reads like a business or partnership inquiry rather than a normal customer question, so I didn't try to negotiate or answer on your behalf.",
  complaint: "This customer sounds unhappy, so I wanted you to see it and respond personally rather than have me smooth it over.",
  refund: "They're asking about a refund or getting money back — that's your call, not mine.",
  custom_request: "They're asking for something custom, private, or outside our normal offering, so I didn't want to improvise on pricing or availability.",
  standing_rule: "This matches a rule you asked me to always bring to you before responding.",
}

/**
 * Assembles a founder-readable handoff note: why Caye stopped, what the
 * customer actually said, and what she already did about it. Shared by
 * every forced-escalation path (this file's four hardcoded triggers, plus
 * lib/standing-rules.ts's owner-taught and sticky-hold variants) so the
 * quality bar is the same regardless of which trigger fired.
 *
 * Deliberately not "no internal vocabulary" as an afterthought — the
 * whole point of `reason` being an argument (not derived from `trigger`
 * inside here) is that every call site has to supply real prose, not a
 * label this function could accidentally leak.
 */
export function humanEscalationNote(reason: string, customerMessage: string): string {
  const excerpt = customerMessage.replace(/\s+/g, ' ').trim().slice(0, 280)
  return `${reason} They wrote: "${excerpt}". I sent a short holding reply and let them know the team would follow up, rather than answer in detail myself.`
}

function build(
  trigger: ForcedTrigger,
  category: ForcedEscalation['category'],
  routeTo: ForcedEscalation['routeTo'],
  body: string
): ForcedEscalation {
  // Distill the customer's first sentence for the ping summary — strip newlines
  // and trim so the WhatsApp template renders cleanly.
  const customerAsk = body.replace(/\s+/g, ' ').trim().slice(0, 100)

  // When the inbound is a parseable form submission (Web3Forms and similar
  // intake widgets), append a deterministic recap of what was actually
  // read — see buildCustomerRecap's own comment for why this doesn't
  // paraphrase the notes field, only quotes it. Prose inbound (a normal
  // email/WhatsApp message) gets the locked stem unchanged, same as before.
  const recap = buildCustomerRecap(body)
  const customerFacingMessage = recap ? `${TEMPLATES[trigger]} ${recap}` : TEMPLATES[trigger]

  return {
    trigger,
    category,
    routeTo,
    customerFacingMessage,
    pingSummary: `${PING_LABELS[trigger]} — "${customerAsk}"`,
    internalContext: humanEscalationNote(TRIGGER_REASON[trigger], body),
  }
}

// ── Hybrid sentiment cascade (Haiku second-pass) ────────────────────────────
// Called when the keyword classifier returns nothing but the body has soft
// emotional signals (length + punctuation). Asks Haiku to make a binary
// complaint / not-complaint judgment. Matches the cascade pattern from #47
// (Haiku primary; Sonnet fallback handled here too, kept thin).
//
// Gated by SOFT_SIGNAL_PATTERN — without a soft signal we don't pay for the
// call. False negatives here are acceptable: Layer 2 (LLM self-rated
// confidence on send_reply) catches the cases we miss.

const SOFT_SIGNAL_PATTERN =
  /[!?]|\b(issue|issues|problem|problems|concern|concerns|wrong|broken|disappointed|frustrat|wait(?:ing)?|still hasn'?t|why is|why did|no(?: one)? (?:replied|answered|got back))\b/i

const SUBTLE_COMPLAINT_MODEL = 'claude-haiku-4-5-20251001'
const SUBTLE_COMPLAINT_FALLBACK_MODEL = 'claude-sonnet-4-6'

export async function detectSubtleComplaint(
  body: string,
  workspaceId: string
): Promise<boolean> {
  if (!SOFT_SIGNAL_PATTERN.test(body)) return false
  if (body.trim().length < 50) return false

  const userContent =
    "Is the following customer message expressing a complaint, dissatisfaction, frustration, or " +
    "an unresolved problem with our business? Answer with one word: YES or NO. Borderline " +
    "cases — questions about delays, requests for an update on something that should have been " +
    "handled, mild expressions of inconvenience — count as YES. Casual questions count as NO.\n\n" +
    `MESSAGE:\n${body.slice(0, 1500)}`

  const ask = async (model: string): Promise<string | null> => {
    try {
      const response = await loggedMessagesCreate(
        null,
        {
          model,
          max_tokens: 8,
          system: 'You are a binary classifier. Reply with exactly YES or NO. Nothing else.',
          messages: [{ role: 'user', content: userContent }],
        },
        { source: 'lib/forced-escalation.ts:detectSubtleComplaint', task: 'classification', workspaceId }
      )
      const text = response.content.find((b) => b.type === 'text')
      return text && text.type === 'text' ? text.text.trim().toUpperCase() : null
    } catch (err) {
      console.error('[forced-escalation] subtle-complaint call failed:', err)
      return null
    }
  }

  const haiku = await ask(SUBTLE_COMPLAINT_MODEL)
  if (haiku === 'YES') return true
  if (haiku === 'NO') return false

  // Haiku gave something unparseable — single Sonnet retry, matching the #47
  // cascade shape.
  const sonnet = await ask(SUBTLE_COMPLAINT_FALLBACK_MODEL)
  return sonnet === 'YES'
}

/**
 * Build a forced complaint escalation when the subtle-complaint cascade
 * fires. Same shape as the keyword-driven complaint path so the downstream
 * caller can treat them identically.
 */
export function buildSubtleComplaintEscalation(body: string): ForcedEscalation {
  return build('complaint', 'policy', 'owner', body)
}
