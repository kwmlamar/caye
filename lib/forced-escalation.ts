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
import Anthropic from '@anthropic-ai/sdk'
import type { InboundCategory } from './inbound-classifier'
import { loggedMessagesCreate } from './llm-telemetry'

export type ForcedTrigger =
  | 'b2b_partnership'
  | 'complaint'
  | 'refund'
  | 'custom_request'

export interface ForcedEscalation {
  trigger: ForcedTrigger
  category: 'gap' | 'policy' | 'knowledge' | 'sensitive'
  routeTo: 'owner' | 'founder' | 'both'
  customerFacingMessage: string
  internalContext: string
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
}

// ── Keyword patterns ───────────────────────────────────────────────────────
// Refund pattern looks for refund/money-back language. NOT bundled into the
// complaint classifier even though it overlaps — refund gets a neutral
// acknowledge, complaint gets an empathy line. Different template needs
// different detection paths.
const REFUND_PATTERN =
  /\b(refund|money back|chargeback|charge back|reverse the charge|get my money|my deposit back|return my deposit|i want my money|i want a refund|process(?:ing)? a refund)\b/i

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
 * (sensitive vs policy).
 *
 * `classifierCategory` comes from classifyInbound() — we re-use its
 * complaint / b2b decisions instead of re-running keyword detection here.
 */
export function detectForcedEscalation(
  body: string,
  classifierCategory: InboundCategory | null
): ForcedEscalation | null {
  if (classifierCategory === 'complaint') {
    return build('complaint', 'policy', 'owner', body, 'inbound classifier — complaint keywords')
  }
  if (classifierCategory === 'b2b_partnership') {
    return build(
      'b2b_partnership',
      'sensitive',
      'owner',
      body,
      'inbound classifier — B2B / partnership voice'
    )
  }
  if (REFUND_PATTERN.test(body)) {
    return build('refund', 'policy', 'owner', body, 'refund / money-back keyword in body')
  }
  if (CUSTOM_REQUEST_PATTERN.test(body)) {
    return build(
      'custom_request',
      'policy',
      'owner',
      body,
      'custom / private / exception language in body'
    )
  }
  return null
}

function build(
  trigger: ForcedTrigger,
  category: ForcedEscalation['category'],
  routeTo: ForcedEscalation['routeTo'],
  body: string,
  why: string
): ForcedEscalation {
  return {
    trigger,
    category,
    routeTo,
    customerFacingMessage: TEMPLATES[trigger],
    internalContext:
      `Forced escalation — ${trigger} (${why}). ` +
      `Customer message excerpt: "${body.slice(0, 280)}". ` +
      `Caye did not draft a substantive reply; the customer-facing send was a controlled template. ` +
      `Owner: review the thread and respond directly.`,
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

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const userContent =
    "Is the following customer message expressing a complaint, dissatisfaction, frustration, or " +
    "an unresolved problem with our business? Answer with one word: YES or NO. Borderline " +
    "cases — questions about delays, requests for an update on something that should have been " +
    "handled, mild expressions of inconvenience — count as YES. Casual questions count as NO.\n\n" +
    `MESSAGE:\n${body.slice(0, 1500)}`

  const ask = async (model: string): Promise<string | null> => {
    try {
      const response = await loggedMessagesCreate(
        client,
        {
          model,
          max_tokens: 8,
          system: 'You are a binary classifier. Reply with exactly YES or NO. Nothing else.',
          messages: [{ role: 'user', content: userContent }],
        },
        { source: 'lib/forced-escalation.ts:detectSubtleComplaint', workspaceId }
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
  return build(
    'complaint',
    'policy',
    'owner',
    body,
    'hybrid sentiment cascade — Haiku flagged subtle dissatisfaction'
  )
}
