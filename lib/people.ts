/**
 * Turns a raw contacts row (customer-facing workspace) or outreach_leads
 * row (internal_sales workspace) into what the People page actually shows
 * — a human relationship state, a next action, and short natural-language
 * context. Pulled out of any component so it's unit-testable, and so the
 * two workspace kinds share one normalized output shape (PersonSummary /
 * PersonDetail) rather than the page having two different UIs.
 *
 * Architecture note (2026-08-13 People redesign audit): contacts (inbound)
 * and outreach_leads (sales) are genuinely separate models with no shared
 * identity — confirmed live, unified_conversations.contact_id is 0/165
 * populated on the sales workspace. This module doesn't pretend otherwise;
 * it normalizes two different real sources into one display shape.
 *
 * Prospect state/next-action (2026-08-13, revised same day): originally
 * this module derived prospect state from outreach_leads.status by hand,
 * having concluded outreach_leads.stage was dead schema (NOT NULL DEFAULT
 * 'sourced', no writer at the time). That was correct for the code visible
 * at the time, but origin/main had since gained lib/sales/funnel.ts and
 * lib/sales/next-action.ts (2026-08-12, "make internal_sales an
 * outcome-owning salesperson") — a properly-owned canonical stage vocabulary
 * and next-action policy, built for exactly this need, which this module
 * now defers to entirely rather than re-deriving. See funnel.ts's own doc
 * comment for why stage is still RE-DERIVED here via deriveStage(evidence)
 * rather than trusted from the stored column: that's the intended usage
 * even now that the column has a live writer, since some transitions
 * (e.g. tried_at → demo_started) don't have a writer yet either.
 */

import { deriveStage, SALES_STAGES, type SalesStage, type StageEvidence } from './sales/funnel'
import { decideNextAction, FOLLOWUP_1_DAYS, FOLLOWUP_2_DAYS, MAX_FOLLOWUPS, type LeadState } from './sales/next-action'

export type PersonKind = 'customer' | 'prospect'

/** Wire shape for GET /api/founder/people — one row in the list. */
export interface PersonSummary {
  id: string
  kind: PersonKind
  name: string
  company: string | null
  channel: string | null
  email: string | null
  phone: string | null
  state: string
  stateLabel: string
  rowContext: string | null
  nextAction: string
  needsYou: boolean
  needsYouReason: string | null
  lastInteractionAt: string | null
  conversationId: string | null
}

/** Wire shape for GET /api/founder/people?id= — the person panel. */
export interface PersonDetail extends PersonSummary {
  understanding: string
  current: string
  knownFacts: string[]
  history: { at: string; label: string }[]
  whyFound: string | null
  conversionValue: string | null
}

export type CustomerState =
  | 'new_contact' | 'customer' | 'returning_customer' | 'blocked' | 'opted_out'

export interface Derived {
  state: SalesStage | CustomerState
  stateLabel: string
  /** Short row-level context line — omitted (null) rather than filled with
   *  filler when there's genuinely nothing useful to say. */
  rowContext: string | null
  /** One sentence, panel "Current" section. */
  current: string
  /** What Caye will do next, in plain language — never null; "No further
   *  action" and "Waiting for you" are real values, not omissions. */
  nextAction: string
}

// ── Prospects (outreach_leads, internal_sales workspaces) ──────────────────

export interface ProspectInput {
  /** outreach_leads.stage as currently stored — used ONLY as evidence for
   *  judgment calls this module has no independent way to verify (ICP
   *  qualification, "got through the demo", "is paying"; see evidenceFrom).
   *  Every signal this module CAN verify independently (opted-out,
   *  contacted, demo-link-clicked, replied) is still derived fresh, per
   *  deriveStage's own "don't trust a column that may be stale" reasoning
   *  — see this file's doc comment for why that still applies even now
   *  that the column has a live writer. */
  stage: string
  /** Explicit qualification timestamp; stage text alone is not evidence. */
  qualified_at?: string | null
  /** The older status field — used only as a display-text fallback (e.g.
   *  distinguishing "sent" from "draft" for the artefact-state line). */
  status: string
  opted_out_at: string | null
  /** Only an explicitly classified human inbound is reply evidence. */
  last_inbound_kind?: 'human_reply' | 'automated_ooo' | 'opt_out' | 'bounce_or_delivery_failure' | 'unknown' | null
  disqualified_reason: string | null
  first_touch_sent_at: string | null
  /** Touches actually DELIVERED (outreach_leads.touches_sent), including
   *  the first — NOT nudge_count, which counts attempts including drafts
   *  held for review. See lib/sales/next-action.ts's LeadState doc. */
  touches_sent: number
  last_touch_sent_at: string | null
  tried_at: string | null
  created_at: string
  /** Live-computed (join against unified_messages by lead_email) — not a
   *  stored column, see this file's doc comment. */
  has_replied: boolean
  /** True when the most recent message on their conversation is from the
   *  prospect and nothing has answered it yet (unified_conversations.
   *  last_sender_type === 'customer') — decideNextAction's
   *  hasUnansweredReply, which outranks the send cadence. */
  has_unanswered_reply: boolean
  has_unclassified_inbound?: boolean
  /** Drafted outreach parked for the founder's batch review (a QUEUE hold,
   *  see hold-kinds-shared.ts) — distinct from needsYou, which is reserved
   *  for a genuine individual decision. Affects nextAction text only. */
  awaiting_review: boolean
  /** From the linked unified_conversations row via conversationNeedsFounder
   *  — the exact Inbox/Home Needs You semantics, not re-derived here. */
  needsYou: boolean
}

export const SALES_STAGE_LABEL: Record<SalesStage, string> = {
  sourced: 'Caye researching',
  contacted: 'Contacted',
  engaged: 'Engaged',
  qualified: 'Qualified',
  demo_started: 'Tried the demo',
  activated: 'Explored the demo',
  won: 'Converted',
  lost: 'Cold',
  disqualified: 'Disqualified',
}

function daysAgo(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / (1000 * 60 * 60 * 24)))
}

function fmtDaysAgo(n: number): string {
  if (n === 0) return 'today'
  if (n === 1) return 'yesterday'
  return `${n} days ago`
}

/**
 * Real evidence available to this route, mapped onto StageEvidence.
 * Signals this route can independently verify (opted-out, first-touch
 * delivered, replied, demo link clicked) are computed live. Signals that
 * are themselves a judgment call already made elsewhere (ICP qualification,
 * "got through the demo", "is paying") have no independent re-derivation
 * path here, so they trust the stored stage having explicitly reached that
 * exact value.
 *
 * Deliberately equality checks, not "is the stored stage's array index >=
 * this stage's index" — SALES_STAGES appends the three terminal outcomes
 * (won/lost/disqualified) after the sequential ones, so a rank comparison
 * would read 'disqualified' (last in the array) as being "at or past"
 * qualified/activated/won, which is backwards: a disqualified lead was not
 * paying. Found live 2026-08-13: The Galley Bar & Restaurant is stored as
 * stage='disqualified' with disqualified_reason=null (the reason column
 * predates being populated by every disqualification path, apparently),
 * and a rank-based version of this function read it as isPaying=true.
 */
function evidenceFrom(input: ProspectInput, cadenceExhausted: boolean): StageEvidence {
  const stage = (SALES_STAGES as readonly string[]).includes(input.stage) ? (input.stage as SalesStage) : 'sourced'
  return {
    optedOut: !!input.opted_out_at,
    disqualified: !!input.disqualified_reason || stage === 'disqualified',
    isPaying: stage === 'won',
    demoCompleted: stage === 'activated',
    demoOpened: !!input.tried_at,
    qualified: (stage === 'qualified' && !!input.qualified_at) || stage === 'demo_started' || stage === 'activated' || stage === 'won',
    hasReplied: input.last_inbound_kind === 'human_reply',
    contacted: !!input.first_touch_sent_at,
    cadenceExhausted,
  }
}

/** Days remaining until the next touch is due, for display only ("Follow up
 *  in ~Nd") — mirrors decideNextAction's own anchor/threshold math exactly,
 *  sharing its exported constants, so this can never say something the
 *  decision function itself disagrees with. decideNextAction doesn't expose
 *  a countdown (only due-or-not), which is the one small gap this fills. */
function daysUntilNextTouch(input: ProspectInput, now: Date): number | null {
  if (!input.first_touch_sent_at) return null
  if (input.touches_sent > MAX_FOLLOWUPS) return null
  const anchorMs = Date.parse(input.last_touch_sent_at ?? input.first_touch_sent_at)
  if (isNaN(anchorMs)) return null
  const nextTouch = input.touches_sent + 1
  if (nextTouch !== 2 && nextTouch !== 3) return null
  const required = nextTouch === 2 ? FOLLOWUP_1_DAYS : FOLLOWUP_2_DAYS
  const daysSince = (now.getTime() - anchorMs) / (1000 * 60 * 60 * 24)
  return Math.max(0, Math.ceil(required - daysSince))
}

export function deriveProspect(input: ProspectInput, now: Date): Derived {
  const leadStateFor = (stage: SalesStage): LeadState => ({
    stage,
    firstTouchSentAt: input.first_touch_sent_at,
    touchesSent: input.touches_sent,
    lastTouchSentAt: input.last_touch_sent_at,
    optedOutAt: input.opted_out_at,
    hasUnansweredReply: input.last_inbound_kind === 'human_reply' && input.has_unanswered_reply,
    hasUnclassifiedInbound: input.has_unclassified_inbound,
    lastInboundKind: input.last_inbound_kind,
    disqualifyingSignal: null, // detecting a NEW disqualifier is a conversational judgment call this route doesn't re-run; disqualified_reason (already recorded) feeds `disqualified` evidence instead.
  })

  // Pass 1: derive stage from evidence that doesn't depend on cadence, to
  // get a stage for decideNextAction to reason about (e.g. "prospect is
  // mid-demo, don't chase them"). Pass 2 (below) adds cadence-exhausted
  // evidence, which can only ever move a 'contacted' lead to 'lost'.
  const preliminaryStage = deriveStage(evidenceFrom(input, false))
  const action = decideNextAction(leadStateFor(preliminaryStage), now)
  const cadenceExhausted = action.kind === 'mark_cold'
  const stage = deriveStage(evidenceFrom(input, cadenceExhausted))

  const stateLabel = SALES_STAGE_LABEL[stage]
  const rowContext = rowContextFor(input, stage, now)
  const nextAction = nextActionTextFor(action, input, stage, now)
  const current = currentTextFor(input, stage, action, now)

  return { state: stage, stateLabel, rowContext, current, nextAction }
}

function rowContextFor(input: ProspectInput, stage: SalesStage, now: Date): string | null {
  if (input.awaiting_review) return 'Draft ready for your review'
  switch (stage) {
    case 'sourced': return 'Not yet contacted'
    case 'disqualified': return input.disqualified_reason ? capitalize(input.disqualified_reason) : null
    case 'lost': return `No reply after ${input.touches_sent} touch${input.touches_sent === 1 ? '' : 'es'}`
    case 'won': return 'Converted'
    case 'demo_started': return 'Tried the Caye demo'
    case 'activated': return 'Completed the demo'
    default:
      return input.first_touch_sent_at
        ? `Caye contacted them ${fmtDaysAgo(daysAgo(input.first_touch_sent_at, now))}`
        : null
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s
}

function nextActionTextFor(action: ReturnType<typeof decideNextAction>, input: ProspectInput, stage: SalesStage, now: Date): string {
  if (input.needsYou) return 'Waiting for you'
  if (input.awaiting_review) return 'Waiting for you to review and send'
  switch (action.kind) {
    case 'reply_to_prospect': return 'Caye replying'
    case 'send_first_touch': return 'Caye will reach out soon'
    case 'send_followup': return 'Follow-up due'
    case 'mark_disqualified': return 'No further action'
    case 'mark_cold': return 'No further action'
    case 'do_nothing':
      if (action.reason === 'not_yet_due') {
        const daysLeft = daysUntilNextTouch(input, now)
        return daysLeft == null ? 'No further action' : daysLeft === 0 ? 'Follow-up due' : `Follow up in ~${daysLeft}d`
      }
      if (action.reason === 'stage_beyond_cadence') {
        // A real conversation is already underway and nothing is currently
        // unanswered — no scheduled send is pending. demo_started/activated
        // haven't replied at all yet (waiting on the tracked click to turn
        // into a reply); engaged/qualified already have, so Caye's handling
        // an ongoing thread rather than watching for a first response.
        return stage === 'demo_started' || stage === 'activated' ? 'Caye watching for a reply' : 'Caye handling'
      }
      if (action.reason === 'awaiting_first_touch_prerequisites') return 'Caye will reach out soon'
      return 'No further action'
  }
}

function currentTextFor(input: ProspectInput, stage: SalesStage, action: ReturnType<typeof decideNextAction>, now: Date): string {
  if (input.needsYou) return "They've replied, but need your call on something."
  if (input.awaiting_review) return 'Caye drafted an outreach message and is waiting on you to review and send it.'
  switch (stage) {
    case 'sourced': return "Sourced — Caye hasn't reached out yet."
    case 'disqualified': return `Not a fit${input.disqualified_reason ? ` — ${input.disqualified_reason}` : ''}. Caye stopped outreach.`
    case 'lost': return `No reply after ${input.touches_sent} touch${input.touches_sent === 1 ? '' : 'es'} — Caye stopped following up.`
    case 'won': return 'Converted — now a Caye customer.'
    case 'engaged': return "They've replied — Caye is handling the conversation."
    case 'qualified': return "They've replied and look like a real fit — Caye is progressing the conversation."
    case 'demo_started': return 'Tried the self-serve Caye demo, no reply on email yet.'
    case 'activated': return 'Made it through the demo and saw Caye work, no reply on email yet.'
    case 'contacted': {
      const touches = input.touches_sent || 1
      if (action.kind === 'send_followup' || (action.kind === 'do_nothing' && action.reason === 'not_yet_due')) {
        return `Waiting for reply — ${touches === 1 ? 'first touch' : `touch ${touches}`} sent, no response yet.`
      }
      return input.first_touch_sent_at
        ? `Caye contacted them ${fmtDaysAgo(daysAgo(input.first_touch_sent_at, now))}, no reply yet.`
        : 'Contacted, no reply yet.'
    }
  }
}

/**
 * "Caye's understanding" paragraph for the person panel — composed only
 * from real fields (name, real dates/counts on the row). Never invents
 * qualitative claims about what the business does or why an inquiry
 * pattern exists — that kind of insight isn't in outreach_leads today
 * (see this file's doc comment on the sourcing gap); a template that
 * asserted it anyway would be exactly the fabrication the person panel
 * spec explicitly rules out.
 */
export function describeProspectUnderstanding(name: string, input: ProspectInput, now: Date): string {
  const sentences: string[] = []
  if (input.first_touch_sent_at) {
    sentences.push(`Caye first reached out to ${name} ${fmtDaysAgo(daysAgo(input.first_touch_sent_at, now))}.`)
  } else {
    sentences.push(`${name} was sourced by Caye's outreach program and hasn't been contacted yet.`)
  }
  if (input.touches_sent > 1) sentences.push(`She's sent ${input.touches_sent} outreach messages so far.`)
  if (input.last_inbound_kind === 'human_reply') {
    sentences.push('They\'ve replied — Caye is handling the conversation from here.')
  } else if (input.tried_at) {
    sentences.push(`They tried the self-serve Caye demo ${fmtDaysAgo(daysAgo(input.tried_at, now))}, but haven't replied on email.`)
  } else if (input.first_touch_sent_at) {
    sentences.push('No reply yet.')
  }
  return sentences.join(' ')
}

/** Mirrors lib/sales/signals.ts's SignalKind/LeadSignal as plain structural
 *  types — that module is 'server-only' (it takes a Supabase client), so
 *  this file (imported by client components) can't import it directly; the
 *  route fetches the rows server-side and hands them to this pure renderer. */
export type ProspectSignalKind = 'objection' | 'question' | 'intent' | 'disqualifier' | 'escalation' | 'outcome'
export interface ProspectSignal {
  kind: ProspectSignalKind
  label: string
  detail: string | null
}

/** Founder-facing phrasing — deliberately different tone from
 *  lib/sales/signals.ts's SIGNAL_PHRASING, which renders the same data into
 *  a model prompt. This is "what Caye knows" for a person reading it, not
 *  instruction text for Caye herself. */
const PERSON_SIGNAL_PHRASING: Record<ProspectSignalKind, string> = {
  objection: 'Pushed back on',
  question: 'Asked about',
  intent: 'Showed interest in',
  disqualifier: 'Not a fit because of',
  escalation: 'Needed your judgment on',
  outcome: 'Result',
}

/** "What Caye knows" bullets for a prospect, from real sales_lead_signals
 *  rows only — one line per signal, most recent first, nothing invented.
 *  Excludes kind='outcome': every real row of that kind seen live
 *  (2026-08-13) is internal send-batching telemetry (label
 *  'held_daily_cap_reached') rather than anything about the person — the
 *  same "internal mechanics reaching a founder-facing surface" class of
 *  leak this session's operator-text-guard.ts work targets elsewhere. The
 *  other five kinds (objection/question/intent/disqualifier/escalation)
 *  are unambiguously about the relationship. */
export function prospectKnownFacts(signals: ProspectSignal[]): string[] {
  return signals
    .filter((s) => s.kind !== 'outcome')
    .map((s) => {
      const readable = s.label.replace(/_/g, ' ')
      const detail = s.detail ? ` — ${s.detail}` : ''
      return `${PERSON_SIGNAL_PHRASING[s.kind]} ${readable}${detail}`
    })
}

// ── Customers (contacts + bookings, customer-facing workspaces) ────────────

export interface CustomerBookingSummary {
  count: number
  upcoming: { service_name: string | null; booking_date: string } | null
}

export interface CustomerInput {
  is_blocked: boolean
  opted_out: boolean
  bookings: CustomerBookingSummary
  needsYou: boolean
}

export const CUSTOMER_STATE_LABEL: Record<CustomerState, string> = {
  new_contact: 'New contact',
  customer: 'Customer',
  returning_customer: 'Returning customer',
  blocked: 'Blocked',
  opted_out: 'Opted out',
}

export function deriveCustomer(input: CustomerInput): Derived {
  if (input.is_blocked) {
    return { state: 'blocked', stateLabel: CUSTOMER_STATE_LABEL.blocked, rowContext: null, current: 'Blocked — Caye will not message them.', nextAction: 'No further action' }
  }
  if (input.opted_out) {
    return { state: 'opted_out', stateLabel: CUSTOMER_STATE_LABEL.opted_out, rowContext: null, current: 'Opted out of messages.', nextAction: 'No further action' }
  }

  const { count, upcoming } = input.bookings
  const state: CustomerState = count === 0 ? 'new_contact' : count > 1 ? 'returning_customer' : 'customer'
  const rowContext = count > 0 ? `${count} booking${count === 1 ? '' : 's'}` : null

  if (input.needsYou) {
    return {
      state, stateLabel: CUSTOMER_STATE_LABEL[state], rowContext,
      current: 'Waiting for you — Caye needs a decision on this conversation.',
      nextAction: 'Waiting for you',
    }
  }
  if (upcoming) {
    // booking_date is a bare YYYY-MM-DD (no time component) — formatting
    // without pinning UTC renders it in the viewer's local timezone, which
    // can shift it a day earlier (e.g. "2026-09-01" reading as "August 31"
    // west of UTC). It names a calendar date, not an instant, so it must
    // always format as the date it says regardless of viewer timezone.
    const when = new Date(`${upcoming.booking_date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
    return {
      state, stateLabel: CUSTOMER_STATE_LABEL[state], rowContext,
      current: `Upcoming booking${upcoming.service_name ? ` — ${upcoming.service_name}` : ''} on ${when}.`,
      nextAction: 'No further action',
    }
  }
  if (count > 0) {
    return {
      state, stateLabel: CUSTOMER_STATE_LABEL[state], rowContext,
      current: 'No active booking.',
      nextAction: 'No further action',
    }
  }
  return {
    state, stateLabel: CUSTOMER_STATE_LABEL[state], rowContext,
    current: 'No booking yet — Caye is handling the conversation.',
    nextAction: 'No further action',
  }
}

/** Mirrors types/database.ts's CustomerFacts — duplicated as a plain
 *  structural type here rather than imported, so this module (shared with
 *  client components) never pulls in the rest of types/database.ts. */
export interface PersonFacts {
  dietary?: string[] | null
  mobility?: string[] | null
  group_composition?: string | null
  preferences?: string[] | null
  occasions?: string[] | null
}

/** "What Caye knows" bullet list for the person panel — one line per real
 *  fact, nothing synthesized. Empty array (not a placeholder string) when
 *  there's nothing yet; the panel renders its own empty state for that. */
export function customerKnownFacts(facts: PersonFacts | null): string[] {
  if (!facts) return []
  const lines: string[] = []
  if (facts.group_composition) lines.push(`Usually travels ${facts.group_composition}`)
  if (facts.preferences?.length) lines.push(`Interested in ${facts.preferences.join(', ')}`)
  if (facts.occasions?.length) lines.push(`Has mentioned: ${facts.occasions.join(', ')}`)
  if (facts.dietary?.length) lines.push(`Dietary: ${facts.dietary.join(', ')}`)
  if (facts.mobility?.length) lines.push(`Mobility: ${facts.mobility.join(', ')}`)
  return lines
}

/**
 * "Caye's understanding" paragraph for a customer — composed from real
 * booking history and AI-derived facts only. No claims about the person
 * beyond what ai_contact_facts/booking rows actually captured.
 */
export function describeCustomerUnderstanding(name: string, input: CustomerInput, facts: PersonFacts | null): string {
  const sentences: string[] = []
  const { count } = input.bookings
  if (count > 0) {
    sentences.push(`${name} has booked ${count} time${count === 1 ? '' : 's'}.`)
  } else {
    sentences.push(`${name} hasn't booked yet.`)
  }
  if (facts?.group_composition) sentences.push(`Usually travels ${facts.group_composition}.`)
  if (facts?.preferences?.length) sentences.push(`Has shown interest in ${facts.preferences.join(', ')}.`)
  return sentences.join(' ')
}
