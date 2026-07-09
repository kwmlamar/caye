import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { VoiceProfile } from '@/lib/voice-profile'
import { stripWrappingQuotes } from '@/lib/voice-profile'
import type { ContactStyleProfile } from '@/types/database'
import { createServiceClient } from './supabase-server'
import { detectIdentityLeak } from './caye-identity-guard'
import { sanitizeDashes } from './sanitize-dashes'
import { formatHistoryBlock } from './conversation-history'
import { checkBookingAutonomy, AUTONOMY_WINDOW_HOURS } from './booking-policy'
import { syncBookingToCalendar } from './calendar-sync'
import { resolveTier, type PricingTier } from './services/resolve-tier'
import {
  evaluateOperatingDate,
  type BlackoutRange,
} from './services/operating-rules'
import {
  matchServiceByName,
  extractCustomerTourName,
  buildMatchHintBlock,
  type ServiceMatchResult,
} from './services/match-service'
import {
  summarizeBookingHistory,
  formatCustomerHistoryBlock,
  type CustomerHistorySummary,
  type BookingHistoryRow,
} from './customer-history'
import { classifyInbound, toneHintFor, type InboundCategory } from './inbound-classifier'
import { formatCustomerFactsBlock, type CustomerFacts } from './customer-facts'
import {
  fetchBusinessFacts,
  formatBusinessFactsBlock,
  type BusinessFactRow,
} from './business-facts'
import { loggedMessagesCreate } from './llm-telemetry'
import {
  detectForcedEscalation,
  detectSubtleComplaint,
  buildSubtleComplaintEscalation,
  type ForcedEscalation,
} from './forced-escalation'

export type EscalationCategory = 'gap' | 'policy' | 'knowledge' | 'sensitive'
export type EscalationRouteTo = 'owner' | 'founder' | 'both'

export type CayeAutoReply =
  | {
      action: 'escalate'
      /** Customer-facing reply Caye sends immediately. Vague by default ("Let
       *  me check with the team"). The customer hears something now; the
       *  operator handles the substance asynchronously. */
      content: string
      /** Routing + categorization that the webhook layer turns into queue
       *  rows + a caye_escalations record. */
      category: EscalationCategory
      routeTo: EscalationRouteTo
      /** Internal context for the operator ping — full thread summary,
       *  customer ask, Caye's reasoning, suggested response. */
      internalContext: string
      /** Optional plain-language one-liner for the WhatsApp ping template.
       *  Forced escalations always supply one; when absent, the ping falls
       *  back to deriving from category + internalContext. */
      pingSummary?: string
    }
  | {
      action: 'reply'
      content: string
      bookingId?: string
      /**
       * Acknowledge-and-defer mode (2B): Caye sent the customer a reply, but
       * the request still needs an owner decision (off-menu service, custom
       * pricing tier, special arrangement). When true, the conversation has
       * been marked `human_agent_enabled=true` so the operator sees it in
       * their attention queue even though Caye replied autonomously.
       *
       * Locked 2026-05-31 — see decisions-log "Caye catalog behavior: upon-
       * request tiers use acknowledge + qualify + defer (2B)".
       */
      needsOwnerFollowup?: boolean
      /** Short note explaining what the owner needs to follow up on. */
      ownerNote?: string
    }
  | {
      action: 'hold'
      reason: string
      note: string
      proposedReply?: string
      /**
       * Optional warm one-liner to send to the customer immediately so they
       * don't feel dropped while the held thread waits on the operator
       * (receptionist-spec.md Q7). When set, the channel webhook sends it as
       * a normal outbound message via the same path as autonomous replies.
       * When absent, the customer hears silence — correct for newsletters,
       * vendor pitches, and other non-question inbound.
       *
       * Already identity-guarded by caye-reply before this leaves the brain
       * — webhooks can send the string verbatim.
       */
      customerAcknowledgement?: string
      /**
       * Operator-ping urgency. Used by the WhatsApp outbound trigger layer to
       * decide whether to ping immediately or batch into the morning digest.
       * If absent, the caller should compute it with classifyHoldUrgency()
       * from lib/whatsapp/urgency.ts.
       */
      urgency?: 'urgent' | 'routine'
    }

interface ServiceRow {
  id: string
  name: string
  duration_minutes: number
  description?: string | null
  is_shared: boolean
  max_capacity: number
  visibility?: 'public' | 'private' | null
}

const MAX_TOOL_ROUNDS = 6

// Tools are declared once at module scope so prompt caching can pin them.
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_availability',
    description:
      'Look up what bookings already exist on a given date for this business. ' +
      'ALWAYS call this before create_booking so you can recommend an open slot ' +
      'and avoid double-booking. Returns a list of existing bookings with their ' +
      'start time, duration, and party size.\n\n' +
      'It also enforces the business\'s operating rules. The result may include:\n' +
      '- closed:true with closed_label — the business is CLOSED that date. Do NOT ' +
      'quote or create_booking. send_reply warmly that they\'re closed then, offer ' +
      'to help with another date, and set flag_for_owner_followup=true.\n' +
      '- owner_only:true — that weekday is handled personally by the owner. Do NOT ' +
      'quote or create_booking. send_reply acknowledging the request and that the ' +
      'owner will follow up directly to arrange it, and set flag_for_owner_followup=true.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'The date to check, in YYYY-MM-DD format.',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'create_booking',
    description:
      'Create a confirmed or pending booking for this customer. Only call this ' +
      'after the customer has clearly agreed to a specific date and time AND you ' +
      'have called check_availability for that date. Use the customer\'s name from ' +
      'the conversation. If you don\'t know their phone or email, omit those fields ' +
      '— don\'t make them up. After this tool succeeds, you MUST then call ' +
      'send_reply with a warm confirmation message that restates the booking details.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customer_name: { type: 'string', description: 'Customer full name.' },
        customer_phone: { type: 'string', description: 'Phone number if known.' },
        customer_email: { type: 'string', description: 'Email if known.' },
        booking_date: { type: 'string', description: 'YYYY-MM-DD.' },
        booking_time: { type: 'string', description: '24-hour HH:MM start time.' },
        number_of_people: {
          type: 'number',
          description: 'Number of guests. Default to 1 if not mentioned.',
        },
        duration_minutes: {
          type: 'number',
          description:
            'How long the booking lasts, in minutes. Omit when the customer didn\'t say — ' +
            'the service\'s default duration (or 120 min) will be used.',
        },
        service_id: {
          type: 'string',
          description: 'Service id from the AVAILABLE SERVICES list. Omit if none fits.',
        },
        notes: { type: 'string', description: 'Any special requests or context.' },
        status: {
          type: 'string',
          enum: ['confirmed', 'pending'],
          description:
            'ALMOST ALWAYS "pending". Use "pending" any time the customer has agreed ' +
            'to date/time/price but has NOT yet paid — including when they say "yes ' +
            'book it" or "sounds great." Payment is the only thing that promotes to ' +
            '"confirmed", and that happens automatically when the payment receipt is ' +
            'scanned — NOT from a chat reply. Only use "confirmed" if you are ' +
            'creating a record for a booking the owner explicitly tells you was ' +
            'already paid. If unsure, use "pending".',
        },
      },
      required: ['customer_name', 'booking_date', 'booking_time'],
    },
  },
  {
    name: 'send_reply',
    description:
      'Send a reply to the customer. Use this when you can confidently handle the message.\n\n' +
      'ACKNOWLEDGE-AND-DEFER (2B mode): When the customer asks for something genuinely ' +
      'off-menu (a service not in AVAILABLE SERVICES), or asks for a service with ' +
      'custom/upon-request pricing you cannot quote, send_reply with an acknowledgment ' +
      'and 1-2 qualifying questions — and set flag_for_owner_followup=true with an ' +
      'owner_note describing what the owner needs to decide. The customer gets an ' +
      'immediate reply (no silent hold); the conversation is flagged in the operator\'s ' +
      'queue as "needs your decision." Do NOT quote any price in this mode.\n\n' +
      'CLARIFYING QUESTION mode: When lookup_price returns ok:false due to a multi-tier ' +
      'or ambiguous-match issue the CUSTOMER can resolve in one reply (e.g. "Golf Cart ' +
      'Guided Tour" matches both the 1hr Orientation and the 2hr Fully Guided), send_reply ' +
      'with a clarifying question naming the tier options — do NOT hold_for_human. The ' +
      'customer answers, you re-run lookup_price, you book. No owner action needed, so ' +
      'flag_for_owner_followup stays unset.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The reply to send to the customer.' },
        flag_for_owner_followup: {
          type: 'boolean',
          description:
            'Set to true ONLY in acknowledge-and-defer (2B) mode: customer-facing ' +
            'acknowledgment goes out, but the underlying decision (pricing, custom ' +
            'arrangement) still needs the owner. Conversation will be flagged in the ' +
            'operator\'s attention queue. Do NOT set for clarifying questions or ' +
            'normal sends — those don\'t need owner follow-up.',
        },
        owner_note: {
          type: 'string',
          description:
            'When flag_for_owner_followup=true: one short sentence telling the owner ' +
            'what they need to do (e.g. "Quote Bimini Beach Experience for 2 adults on ' +
            'Sept 6 — Alice Town + beach with amenities"). Shown in the inbox.',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description:
            'YOUR self-rated confidence in this reply (Layer 2 of the confidence model, #57). ' +
            'Rate honestly — under-confidence is fine, over-confidence is not.\n' +
            '- high: you have direct evidence for every fact in the reply (a tool returned ' +
            'it this turn, or it\'s in AVAILABLE SERVICES / the system prompt). You\'d be ' +
            'comfortable sending this verbatim with no operator review.\n' +
            '- medium: the reply is reasonable but you\'re inferring at least one piece of ' +
            'information from context rather than direct evidence (e.g. assuming a default ' +
            'duration the customer didn\'t specify, guessing intent from vague phrasing).\n' +
            '- low: you drafted something but you\'re not sure it\'s right — the customer ' +
            'asked about something outside what you have data on, or the request feels ' +
            'borderline and might need owner judgment.\n\n' +
            'medium or low triggers an escalation automatically — your drafted reply still ' +
            'goes to the customer (no silent hold), but the operator is pinged with the ' +
            'thread and gets the chance to follow up. This is the safety net; use it.',
        },
      },
      required: ['content', 'confidence'],
    },
  },
  {
    name: 'lookup_price',
    description:
      'Resolve the EXACT price for a given service + group size. ALWAYS call this ' +
      'before mentioning any price in send_reply. NEVER quote a price from memory or ' +
      'from the system prompt — call this tool every time.\n\n' +
      'Returns either:\n' +
      '  { ok: true, price_label, total_label, total_amount } — quote these verbatim. ' +
      'price_label is the per-tier rate (e.g. "$110/person"); total_label is the party ' +
      'total (e.g. "$300 total"). Both are pre-formatted for the email/message.\n' +
      '  { ok: false, hold, message } — DO NOT quote a price. Decide between three paths:\n' +
      '    (a) CLARIFY: if the customer can resolve the ambiguity in one reply (multi-tier ' +
      'match like Golf Cart Guided Tour 1hr Orientation vs 2hr Fully Guided, OR a gap ' +
      'between tiers the customer could clarify by saying which option they want), call ' +
      'send_reply with a clarifying question naming the options. No hold needed.\n' +
      '    (b) DEFER (2B mode): if the service has custom/upon-request pricing OR the ' +
      'request is genuinely off-menu, call send_reply with an acknowledgment + qualifying ' +
      'questions + flag_for_owner_followup=true. Owner decides the price; customer gets ' +
      'an immediate reply.\n' +
      '    (c) HOLD: only when neither (a) nor (b) fits — e.g. customer is upset, request ' +
      'is unclear in ways even the customer can\'t resolve, or you genuinely don\'t know ' +
      'what to acknowledge. Call hold_for_human with reason="pricing_unresolved" and ' +
      'include the message field in the note.\n\n' +
      'Default order to try: (a) → (b) → (c). Holding is the last resort, not the first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        service_id: {
          type: 'string',
          description: 'Service id from the AVAILABLE SERVICES list. Required.',
        },
        group_size: {
          type: 'number',
          description: 'Number of guests in the party. Must be a positive integer.',
        },
      },
      required: ['service_id', 'group_size'],
    },
  },
  {
    name: 'find_bookings',
    description:
      'Look up existing bookings for a customer. ALWAYS call this BEFORE cancel_booking ' +
      'when a customer asks to cancel — you need the booking_id to act. Match by ' +
      'customer_email first; fall back to customer_name only when email lookup returns ' +
      'nothing. Returns active (confirmed/pending) bookings dated today or later. If the ' +
      'result has 0 rows, hold_for_human (customer claims a booking we have no record of). ' +
      'If it has 2+ rows, reply asking which one (date + service) — DO NOT guess.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customer_email: {
          type: 'string',
          description: 'The sender\'s email address — primary match key.',
        },
        customer_name: {
          type: 'string',
          description:
            'Customer name — fallback when email lookup returns nothing (some older ' +
            'bookings were created without an email captured). Use exact spelling from ' +
            'the conversation.',
        },
      },
      required: [],
    },
  },
  {
    name: 'cancel_booking',
    description:
      'Cancel an existing booking. Only call after find_bookings has returned exactly ' +
      'the booking the customer means. Returns { ok: false, reason: "within_policy_window" } ' +
      'when the booking is within 48 hours of starting — in that case, hold_for_human ' +
      '(last-minute changes are the owner\'s call, not yours). Returns ' +
      '{ ok: false, reason: "booking_in_past" } if the booking has already started — ' +
      'also hold_for_human. On success, you MUST then call send_reply with a brief ' +
      'confirmation. Reply rules: confirm the cancellation, mention they\'re eligible for ' +
      'a full refund per the 48h policy, say the owner will follow up to process the ' +
      'refund. Do NOT promise refund timelines or dollar amounts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        booking_id: {
          type: 'string',
          description: 'The booking id (uuid) from find_bookings.',
        },
        reason: {
          type: 'string',
          description:
            'Why the customer is cancelling — for the internal record. One short sentence.',
        },
      },
      required: ['booking_id'],
    },
  },
  {
    name: 'reschedule_booking',
    description:
      'Move an existing booking to a new date/time of the SAME service. Only call after ' +
      'find_bookings has returned exactly the booking the customer means. The service stays ' +
      'the same — if the customer wants a different service (e.g. switching from Full Bimini ' +
      'Experience to Eat Like a Local), hold_for_human (different price, different operation). ' +
      'Returns { ok: false, reason: "within_policy_window" } when the CURRENT booking is ' +
      'within 48 hours — last-minute changes are the owner\'s call. Returns ' +
      '{ ok: false, reason: "slot_unavailable" } when the new slot is exclusively booked ' +
      'or has no remaining shared capacity — in that case, run check_availability for the ' +
      'new date and suggest an alternative time. If new_time is omitted, the booking\'s ' +
      'existing time is preserved on the new date — tell the customer what you did. After ' +
      'success, you MUST call send_reply with a warm confirmation that restates the new ' +
      'date and time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        booking_id: {
          type: 'string',
          description: 'The booking id (uuid) from find_bookings.',
        },
        new_date: {
          type: 'string',
          description: 'New date in YYYY-MM-DD.',
        },
        new_time: {
          type: 'string',
          description:
            'New start time in 24-hour HH:MM. Omit to preserve the booking\'s existing ' +
            'time on the new date — natural default when the customer says "move to Sunday" ' +
            'without specifying a time.',
        },
        duration_minutes: {
          type: 'number',
          description:
            'Override duration. Omit to keep the existing duration — usually correct.',
        },
      },
      required: ['booking_id', 'new_date'],
    },
  },
  {
    name: 'hold_for_human',
    description:
      'Hold this conversation for the business owner to handle personally. HOLD IS THE LAST ' +
      'RESORT — before holding, consider whether send_reply could handle it instead with ' +
      'either a clarifying question (customer can resolve) or acknowledge-and-defer ' +
      '(flag_for_owner_followup=true, customer still gets an immediate reply while the ' +
      'underlying decision goes to the owner). Hold only when send_reply genuinely cannot ' +
      'do the job.\n\nUse hold when: ' +
      'the customer has a complaint or is upset; cancel_booking or reschedule_booking ' +
      'returned within_policy_window or booking_in_past; the message is ambiguous in a way ' +
      'that even the customer cannot clarify (you cannot draft any sensible acknowledgment); ' +
      'or the request is genuinely outside what the business does (not just "off-menu but ' +
      'related" — those use 2B acknowledge-and-defer). ' +
      'Do NOT hold just because: pricing requires an owner decision (use 2B instead); the ' +
      'service is off-menu but in the business\'s lane (use 2B); a tier match is ambiguous ' +
      '(send a clarifying question); they want to book / cancel / reschedule (use the ' +
      'dedicated tools when the booking is >48h out). ' +
      'IMPORTANT: when you hold, ALSO populate proposed_reply with the reply you WOULD have sent ' +
      'if you were confident. This becomes the operator\'s starting draft — they will review it, ' +
      'edit it, and send it themselves. Voice rules apply to proposed_reply exactly as they apply ' +
      'to send_reply content: no emoji, no tropical / island metaphors, match the operator voice ' +
      'profile. Skip proposed_reply only if you genuinely can\'t draft anything useful (e.g. ' +
      'angry complaint with zero context).',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'One short sentence — why you are stepping back. Shown in the inbox as a label.',
        },
        note: {
          type: 'string',
          description:
            'A brief internal note for the business owner. Write it like a handoff: what the ' +
            'customer needs, any relevant context, what you\'d suggest doing. 2-4 sentences max.',
        },
        proposed_reply: {
          type: 'string',
          description:
            'The reply you would have sent if you were confident — used as the operator\'s ' +
            'starting draft. Same voice rules as send_reply content. Optional: omit only if ' +
            'you genuinely can\'t draft anything useful.',
        },
        customer_acknowledgement: {
          type: 'string',
          description:
            'OPTIONAL short message sent IMMEDIATELY to the customer so they don\'t feel ' +
            'dropped while the operator works the held thread. Warm, 1-2 short sentences, ' +
            'no commitments on timing, never invents a price/date. Examples: "Thanks — let ' +
            'me check on that and get back to you shortly." / "Got your note, will be in ' +
            'touch about timing later today." ' +
            'LEAVE EMPTY when: the inbound is a newsletter, vendor pitch, automated bounce, ' +
            'or anything where the customer did not actually ask you a question — silence is ' +
            'correct there and any reply would compound the noise. Same voice rules as ' +
            'send_reply content. Never quote prices or promise specific times.',
        },
      },
      required: ['reason', 'note'],
    },
  },
  {
    name: 'escalate_to_team',
    description:
      'Open a categorized escalation when Caye lacks the TOOL, POLICY authority, or ' +
      'KNOWLEDGE to answer — instead of refusing or saying "I can\'t help with that." ' +
      'Customer-facing message goes out immediately (warm, vague on timing, never names a ' +
      'specific human); the operator gets a WhatsApp ping with the full thread + your ' +
      'reasoning + a suggested reply.\n\n' +
      'PREFER escalate_to_team OVER hold_for_human whenever the situation fits one of the ' +
      'four categories below — escalation is the structural safety net so "Caye says she ' +
      'can\'t" never happens. Use hold_for_human only for the genuinely-ambiguous cases ' +
      'where even an escalation message has nothing useful to acknowledge.\n\n' +
      'CATEGORY → ROUTE:\n' +
      '- gap (Caye literally lacks the tool — a feature that should exist but doesn\'t, or ' +
      'a bug) → route_to=\'founder\'. The operator can\'t fix this.\n' +
      '- policy (custom price, refund request, exception, complaint, special arrangement) ' +
      '→ route_to=\'owner\'. Only the owner can decide.\n' +
      '- knowledge (a factual gap about the business Caye doesn\'t know — opening hours ' +
      'for a one-off, what\'s included in a specific package, vendor contact) → ' +
      'route_to=\'owner\'. Owner answers; the answer will be captured for next time.\n' +
      '- sensitive (B2B / partnership / commercial-terms / press / regulatory) → ' +
      'route_to=\'owner\'. Per the 2026-06-06 lock — Caye does not handle these.\n' +
      'Use route_to=\'both\' only when the issue genuinely needs the owner\'s call AND the ' +
      'founder needs to be aware (e.g. a category=\'gap\' that is blocking a paying ' +
      'customer mid-booking).\n\n' +
      'CUSTOMER-FACING MESSAGE rules:\n' +
      '- Vague on timing — "let me check with the team and circle back shortly" / "I\'ll ' +
      'get this to the team and get back to you soon." Never "within 24 hours", never ' +
      '"by tomorrow", never specifies who.\n' +
      '- Never names the human ("Karenda will reply"). Use "the team" / "we".\n' +
      '- Never promises an outcome ("we\'ll honor that", "the refund is on its way") — ' +
      'the owner decides, not you.\n' +
      '- Voice rules apply exactly as send_reply: no emoji, no tropical metaphors, match ' +
      'the operator voice profile.\n' +
      '- Still close with the standard sign-off, signature block, and tagline from ' +
      'VERBATIM ELEMENTS, exactly as send_reply does — a short holding message is still ' +
      'a complete email to the customer, not an internal note, and must end the same way ' +
      'every other reply does.\n\n' +
      'INTERNAL CONTEXT rules — write it like a handoff. 2-5 sentences: what the customer ' +
      'actually wants, the specific gap you hit (which tool you tried, what came back), ' +
      'what you\'d suggest the operator do.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: ['gap', 'policy', 'knowledge', 'sensitive'],
          description:
            'Pick the one that fits best — see the CATEGORY → ROUTE list above. The ' +
            'category drives both the routing and the knowledge auto-capture behavior.',
        },
        route_to: {
          type: 'string',
          enum: ['owner', 'founder', 'both'],
          description:
            'Who gets the ping. Follow the category → route mapping unless there\'s a ' +
            'specific reason to fan out (rare — use \'both\' sparingly).',
        },
        customer_facing_message: {
          type: 'string',
          description:
            'The message sent to the customer immediately. Follows the CUSTOMER-FACING ' +
            'MESSAGE rules above. For complaint-flavored escalations, prepend a brief ' +
            'empathy line ("I\'m sorry you had that experience — let me get this to the ' +
            'team and we\'ll make it right.").',
        },
        internal_context: {
          type: 'string',
          description:
            'Handoff note for the operator — what the customer wants, why you escalated, ' +
            'suggested reply if you have one. 2-5 sentences. This text is what actually ' +
            'gets sent to the operator (WhatsApp ping + dashboard) — not customer_facing_message. ' +
            'ALWAYS end with a concrete proposed next action framed as a yes/no the operator ' +
            'can just confirm, e.g. "Want me to confirm Jeff\'s Aug 23 spot at $375 and send ' +
            'payment details, or handle differently?" — never end on a bare status update ' +
            'like "needs your input" with no proposal attached.',
        },
      },
      required: ['category', 'route_to', 'customer_facing_message', 'internal_context'],
    },
    // Cache breakpoint on the last tool caches the entire tools array.
    // 1h TTL chosen 2026-06-24 (#46): bursty traffic spans multiple 5-min
    // windows, and the tools list is stable across deploys.
    cache_control: { type: 'ephemeral', ttl: '1h' },
  },
]

function formatServicesList(services: ServiceRow[]): string {
  if (!services.length) {
    return '(No services configured. Don\'t invent any — if a service is required, hold_for_human.)'
  }
  return services
    .map(s => {
      const desc = s.description ? ` — ${s.description}` : ''
      const capacity = s.is_shared
        ? `, SHARED group tour, capacity ${s.max_capacity} guests/slot`
        : ', exclusive (one party per slot)'
      const privateTag =
        s.visibility === 'private'
          ? ' [PRIVATE — do NOT proactively suggest; honor + quote only when guest names it directly]'
          : ''
      return `- ${s.name} (${s.duration_minutes} min${capacity}) [id: ${s.id}]${privateTag}${desc}`
    })
    .join('\n')
}

interface BusinessLinks {
  booking_url: string | null
  website_url: string | null
}

/**
 * Two-tier system prompt:
 *   - `stable`: workspace-stable content (operator voice, services catalog,
 *     policies, links). Cached at 1h TTL on the model side. Changes only
 *     when the workspace settings change or the policy strings change in
 *     code — both rare events that 1h cache absorbs.
 *   - `dynamic`: per-message content (today's date, customer-specific
 *     profile/history/facts, inbound tone hint, service-match hint,
 *     channel/first-message format rules). NOT cached.
 *
 * The two are concatenated by the caller into a 2-block `system` array so
 * the cached prefix bytes are stable across messages.
 *
 * Locked 2026-06-24 (#46) — previous single-block system mixed dynamic
 * customer data into the cached prefix, giving 20% cache read ratio.
 */
function buildSystem(
  systemPrompt: string,
  voiceProfile: VoiceProfile | undefined,
  contactProfile: ContactStyleProfile | undefined,
  contactFacts: CustomerFacts | undefined,
  businessLinks: BusinessLinks | undefined,
  customerHistory: CustomerHistorySummary | undefined,
  inboundCategory: InboundCategory | null,
  channel: string,
  isEmail: boolean,
  isFirstMessage: boolean,
  services: ServiceRow[],
  todayISO: string,
  serviceMatch: ServiceMatchResult | null,
  businessFacts: BusinessFactRow[]
): { stable: string; dynamic: string } {
  // ── STABLE PREFIX ───────────────────────────────────────────────────────
  let stable = systemPrompt

  stable +=
    '\n\nBUSINESS IDENTITY RULES:\n' +
    '- The operator\'s business is defined by the workspace context above. ' +
    'Never invent a name for the business, never refer to it by anything ' +
    'other than the name in the workspace context. If the workspace context ' +
    'does not name the business, say "your business" or "we" — never make up ' +
    'a name like "Sunset Cruise" or "Island Tours".\n' +
    '- If an inbound email or message looks like it\'s directed at a different ' +
    'business than this workspace serves, explain that explicitly without ' +
    'inventing a name for either side. Use phrases like "this doesn\'t match ' +
    'our services" or "this seems intended for a different company" — never ' +
    'hallucinated business names.'

  if (voiceProfile) {
    stable +=
      '\n\nVOICE PROFILE — write in this person\'s actual style:\n' +
      `- Formality: ${voiceProfile.formality_level}\n` +
      `- Style: ${voiceProfile.writing_style}\n` +
      `- Common phrases to use naturally: ${(voiceProfile.common_phrases ?? []).join(', ')}\n` +
      `- Tone notes: ${voiceProfile.tone_notes}` +
      (voiceProfile.register_override
        ? `\n- Register override (from update_voice_register${voiceProfile.register_scope ? `, scope=${voiceProfile.register_scope}` : ''}): ${voiceProfile.register_override} — bias your phrasing toward this register without abandoning the rest of the profile above.`
        : '')

    // stripWrappingQuotes guards against already-corrupted stored data (a
    // verbatim field saved with literal quote marks baked into the string,
    // e.g. tagline = `"Where Every Tour Tells a Story"`) — without this, the
    // quoted-instruction wrapper below produces doubled quotes (`""..."""`)
    // that can confuse the model into skipping the field entirely.
    const opener = stripWrappingQuotes(voiceProfile.standard_opener)
    const signoff = stripWrappingQuotes(voiceProfile.standard_signoff)
    const tagline = stripWrappingQuotes(voiceProfile.tagline)

    const verbatimLines: string[] = []
    if (opener) {
      verbatimLines.push(`- Opener (use verbatim when starting a new thread): "${opener}"`)
    }
    if (signoff) {
      verbatimLines.push(`- Sign-off line (use verbatim before the signature): "${signoff}"`)
    }
    if (voiceProfile.signature_block) {
      verbatimLines.push(
        `- Signature block (append verbatim, exactly as written, line breaks preserved):\n${voiceProfile.signature_block}`
      )
    }
    if (tagline) {
      verbatimLines.push(
        `- Tagline (always include as its own standalone line immediately after the ` +
        `signature block — never woven into a sentence elsewhere in the message): "${tagline}"`
      )
    }

    if (verbatimLines.length > 0) {
      stable +=
        '\n\nVERBATIM ELEMENTS — these strings must appear EXACTLY as written, never paraphrased, never reworded, never translated:\n' +
        verbatimLines.join('\n')
    }
  }

  // Inject business links only when at least one is set — empty block adds
  // noise to the prompt and could confuse the model into mentioning links
  // that don't exist.
  if (businessLinks && (businessLinks.booking_url || businessLinks.website_url)) {
    const lines: string[] = []
    if (businessLinks.booking_url) lines.push(`- Booking page: ${businessLinks.booking_url}`)
    if (businessLinks.website_url) lines.push(`- Website: ${businessLinks.website_url}`)
    stable +=
      '\n\nBUSINESS LINKS — share when relevant, do not force:\n' +
      lines.join('\n') +
      '\n' +
      'Use these naturally when a customer asks "can I book online?", "where can I see your tours?", ' +
      'or as a self-service option when you hold_for_human ("I\'ll have someone confirm — ' +
      'meanwhile you can browse at <link>"). Never paste them as a robotic footer on every reply ' +
      'and never invent URLs that aren\'t listed here.'
  }

  stable += `\n\nAVAILABLE SERVICES:\n${formatServicesList(services)}`

  stable +=
    '\n\nBOOKING POLICY:\n' +
    '- You can create bookings directly using check_availability + create_booking.\n' +
    '- Always check availability for a date before creating a booking on it.\n' +
    '- CLOSED / OWNER-ONLY DATES — check_availability enforces the owner\'s operating ' +
    'rules. If it returns closed:true, the business is closed that date: do NOT quote or ' +
    'book, send_reply warmly that they\'re closed then (use closed_label if given), offer ' +
    'another date, and set flag_for_owner_followup=true. If it returns owner_only:true, ' +
    'that day is handled personally by the owner: do NOT quote or book, send_reply that the ' +
    'owner will follow up directly to arrange that day, and set flag_for_owner_followup=true. ' +
    'Never create_booking on a closed or owner_only date.\n' +
    '- Only create a booking when the customer has clearly agreed to a specific date and time.\n' +
    '- If they\'re vague ("sometime next week"), reply asking for a specific day and time first.\n' +
    '- STATUS RULE — new bookings are ALWAYS created with status="pending". Agreement is not payment. ' +
    'A booking only becomes "confirmed" when the payment receipt is scanned and matched downstream, ' +
    'never from this conversation. Telling the customer "we have you confirmed" before they pay sets ' +
    'a false expectation and pollutes Karenda\'s booking list with paid-vs-not-paid ambiguity.\n' +
    '- PAYMENT COPY (until the payment-link system is wired) — when you create a pending booking, ' +
    'your reply should: (a) acknowledge the slot is held, (b) confirm date/time/party/price clearly, ' +
    '(c) tell the customer the owner will follow up with payment instructions shortly, (d) NOT promise ' +
    'a specific timeline for the payment link, (e) NOT invent a payment URL. One short paragraph for ' +
    'the held confirmation, one short paragraph for the "payment to follow" note. Example tone: ' +
    '"Your spot is held for [date]. We\'ll send payment details over shortly to lock it in."\n' +
    `- If they want to CANCEL: call find_bookings → cancel_booking. The tool enforces a ${AUTONOMY_WINDOW_HOURS}h policy ` +
    'window — bookings inside that window return an error and you must hold_for_human (Karenda\'s decision). ' +
    'After a successful cancel, send_reply with: confirmation of the cancel, mention that they\'re eligible ' +
    `for a full refund per the ${AUTONOMY_WINDOW_HOURS}h policy, and say the owner will follow up to process the refund. ` +
    'Do NOT promise refund timelines or amounts — you can\'t process payments.\n' +
    '- If they want to RESCHEDULE: call find_bookings → reschedule_booking with new_date (and new_time ' +
    'if they specified one — omit to preserve the existing time on the new date). Same 48h policy applies. ' +
    'If reschedule_booking returns slot_unavailable, call check_availability for the new date and reply ' +
    'with alternative times. After success, send_reply with a warm confirmation restating the new date+time.\n' +
    '- If they want to change to a different SERVICE: hold_for_human (different price, different operation).\n' +
    '- For new bookings: ask for what you need (name, party size, date, time) over the course of ' +
    'the conversation. Don\'t demand it all in one message.\n' +
    '- SHARED services: multiple parties can book the same slot up to the service capacity. ' +
    'check_availability returns total_guests + capacity_remaining per slot. If there\'s room, ' +
    'create_booking with the same date/time as the existing slot — the new party joins the group. ' +
    'If the slot is full, suggest the next time. Mention to the customer they\'ll be joining others.\n' +
    '- EXCLUSIVE services: only one party per slot. If the slot has any booking, suggest another time.'

  stable +=
    '\n\nPRICING POLICY (CRITICAL):\n' +
    '- NEVER quote a price from memory, from the system prompt, or by reading pricing text. ' +
    'ALWAYS call lookup_price(service_id, group_size) and quote the values it returns verbatim.\n' +
    '- If lookup_price returns ok=true: use price_label and total_label exactly as given. ' +
    'Do not round, do not paraphrase, do not multiply on your own. Example: ' +
    'if total_label is "$375 total" you write "$375 total" — not "$187.50/person" or "$300".\n' +
    '- If lookup_price returns ok=false: DO NOT mention any number in your reply. ' +
    'Choose your action by the AUTONOMY DECISION TREE below — clarify if the customer can ' +
    'resolve it, defer if it needs the owner (send_reply + flag_for_owner_followup=true), ' +
    'hold only as the last resort.\n' +
    '- Before quoting any price you have not yet looked up in this turn, call lookup_price first. ' +
    'This is non-negotiable — past pricing mistakes (e.g. quoting the per-person group rate for a 2-person ' +
    'Private tour) cost the owner real money and trust.'

  stable +=
    '\n\nAUTONOMY DECISION TREE (when you cannot directly send a booking confirmation):\n' +
    'Holding is the last resort, not the first. Try these in order:\n' +
    '\n' +
    '1. CLARIFY — send_reply with a clarifying question.\n' +
    '   Use when: the customer can resolve the issue in one reply.\n' +
    '   Examples: multi-tier match ("Golf Cart Guided Tour" → 1hr Orientation OR 2hr Fully ' +
    'Guided), ambiguous group size, ambiguous date, missing pickup info.\n' +
    '   Reply pattern: name the options clearly, ask one specific question, do NOT quote prices.\n' +
    '   No flag_for_owner_followup — the customer\'s reply will unblock the booking, owner ' +
    'doesn\'t need to do anything.\n' +
    '\n' +
    '2. DEFER (2B mode) — send_reply with flag_for_owner_followup=true.\n' +
    '   Use when: the service exists but pricing is custom / upon-request, OR the customer ' +
    'asks for something genuinely off-menu that is still in the business\'s lane.\n' +
    '   Examples: custom transport day, off-menu specialty experience, group/corporate ' +
    'arrangement, "starting at $X" pricing where the actual quote depends on details.\n' +
    '   Reply pattern: warm acknowledgment of what they want, 1-2 qualifying questions ' +
    '(cruise/hotel/fly-in, start/finish times, group composition), explicit "I\'ll be back to ' +
    'you shortly with details and pricing." Do NOT quote any number.\n' +
    '   Set flag_for_owner_followup=true and owner_note describing what the owner needs ' +
    'to decide (e.g. "Quote custom transport day for 4 adults Sept 25 — Max requested").\n' +
    '\n' +
    '3. ESCALATE — escalate_to_team (categorized handoff).\n' +
    '   Use when: you can\'t answer because of a gap in tools, policy authority, or ' +
    'knowledge — AND the situation fits one of the four categories (gap / policy / ' +
    'knowledge / sensitive). See the escalate_to_team tool description for the full ' +
    'category → route_to mapping.\n' +
    '   Customer-facing message goes out immediately (warm, vague on timing — never ' +
    '"by tomorrow", never names the human). Operator gets a categorized WhatsApp ping ' +
    'with the full thread + your suggested reply.\n' +
    '   Prefer ESCALATE over HOLD whenever the situation maps to one of the four ' +
    'categories — escalation is the structural safety net so "Caye says she can\'t" ' +
    'never happens.\n' +
    '\n' +
    '4. HOLD — hold_for_human (last resort).\n' +
    '   Use when: the message is ambiguous in ways even the customer cannot clarify, ' +
    'or you genuinely cannot draft a sensible acknowledgment (angry complaint with zero ' +
    'context, garbled inbound, off-topic message that doesn\'t fit any escalation ' +
    'category). When holding, always include proposed_reply with the draft you would ' +
    'have sent.\n' +
    '\n' +
    'Default to (1), (2), or (3) whenever possible. The customer always gets an immediate response ' +
    'in those modes; the owner gets a clean queue of "decision needed" items instead of a ' +
    'queue of "messages I need to read and respond to."'

  stable += '\n\nSCOPE: Only engage with messages that are actually for the business — booking inquiries, ' +
    'customer questions, payment/logistics follow-ups. If the message is a newsletter, marketing blast, ' +
    'industry/coaching content, cold sales outreach, partnership pitch, vendor notification, or any other ' +
    'non-customer message, call hold_for_human with reason "not a customer message" and let the owner ' +
    'decide. Never make commitments on the owner\'s behalf about signing up for things, attending events, ' +
    'trying products, or replying to industry peers.'

  stable += '\n\nTIME COMMITMENTS: Do NOT commit the owner to specific response windows. ' +
    'Never say "within 24 hours", "by tomorrow", "later today", or any other fixed time promise ' +
    'unless the system prompt or a prior owner instruction explicitly authorizes one for this context. ' +
    'Use "shortly", "soon", "as soon as we can", or omit the time reference entirely. ' +
    'The owner\'s actual response time is unpredictable — every fixed promise you make becomes a ' +
    'broken promise we cannot control.'

  // ── DYNAMIC SUFFIX ──────────────────────────────────────────────────────
  // Per-message content that would bust the cache if folded into `stable`.
  let dynamic = `TODAY'S DATE: ${todayISO}. ` +
    'When the customer says "tomorrow" / "this Saturday" / etc., resolve it against today.'

  if (contactProfile) {
    dynamic +=
      '\n\nCUSTOMER STYLE — adapt your reply to match this person\'s communication style:\n' +
      `- Formality: ${contactProfile.formality}\n` +
      `- Style: ${contactProfile.message_style}\n` +
      `- Language notes: ${contactProfile.language_notes}\n` +
      'Match their energy — if they\'re brief, be brief. If they\'re formal, stay professional. ' +
      'If they use emoji, one or two is fine. Mirror their vibe without abandoning the VOICE PROFILE ' +
      'above (their style controls tone; your owner\'s voice profile controls word choice and identity).'
  }

  // Customer history (returning customer signal). The block renders empty
  // for first-timers so this is safe to call unconditionally.
  if (customerHistory) {
    const historyBlock = formatCustomerHistoryBlock(customerHistory)
    if (historyBlock) dynamic += '\n\n' + historyBlock
  }

  // Customer facts (operational truths they told us — allergies, mobility,
  // group, etc.). The block renders empty when no facts are populated.
  if (contactFacts) {
    const factsBlock = formatCustomerFactsBlock(contactFacts)
    if (factsBlock) dynamic += '\n\n' + factsBlock
  }

  // Business facts (what the owner has taught Caye via add_business_fact —
  // policies, service details, special handling, logistics). Dynamic, not
  // cached: facts change whenever the owner adds one, and the cache TTL
  // would defeat the purpose.
  const bizFactsBlock = formatBusinessFactsBlock(businessFacts)
  if (bizFactsBlock) dynamic += '\n\n' + bizFactsBlock

  // Inbound-context tone modifier. Pure classifier picks a category from
  // the inbound body (or returns null when uncertain); toneHintFor maps
  // the category to a short prompt addendum. When category is null the
  // hint is empty — Caye falls back to her default tone.
  const toneHint = toneHintFor(inboundCategory)
  if (toneHint) dynamic += '\n\n' + toneHint

  // Deterministic service-name match hint (per-message — driven by the
  // customer's inbound text). Closes the Jeff Montenaro / James Stallings
  // stall gap on name mismatches like "Historical" vs "Heritage".
  if (serviceMatch) {
    const hint = buildMatchHintBlock(serviceMatch)
    if (hint) dynamic += hint
  }

  dynamic += isEmail
    ? '\n\nWrite only the reply body — no headers, no markdown, no subject line. Plain prose.' +
      '\n\nSIGN-OFF: Use the exact sign-off block specified earlier in this system prompt — verbatim, ' +
      'including name, business, phone, and email if given. Do NOT invent your own signature. ' +
      'Do NOT sign as "Caye" or any variant. Do NOT mention that you are an AI, assistant, ' +
      'receptionist, or automated system anywhere in the body or the sign-off. From the recipient\'s ' +
      'point of view, the email is from the business owner — write as them, not on their behalf.'
    : isFirstMessage
    ? `\n\nWrite only the reply body. Plain conversational prose — no markdown. Keep it brief — this is ${channel}, not email. Open with a warm, natural greeting. Never mention that you are an AI, assistant, or automated.`
    : `\n\nWrite only the reply body. Plain conversational prose — no markdown. Keep it brief — this is ${channel}, not email. Do NOT open with a greeting or the customer's name — jump straight to the answer. Never mention that you are an AI, assistant, or automated.`

  // First-message brevity rule (email). Counter the verbose-acknowledgement
  // failure mode: a hot lead from an intake form should not get three
  // paragraphs of preamble before the question. See Omayra Calzada
  // 2026-05-31 — three full paragraphs of "thank you so much / we'd love /
  // this is one of our specialty offerings / let me confirm a few details"
  // before the actual qualifying question. Reads like a chatbot. Karenda
  // would write three sentences total.
  if (isEmail && isFirstMessage) {
    dynamic +=
      '\n\nBREVITY (FIRST-CONTACT EMAILS):\n' +
      '- Maximum 2 short paragraphs in the body. One brief acknowledgement, one clear next step (the price, the question, the booking confirmation). Then sign off.\n' +
      '- No more than 2 sentences per paragraph. No restating what the customer already told you.\n' +
      '- Banned filler openers: "Thank you so much for reaching out", "We would absolutely love to", "I am thrilled / delighted / so excited". Use a single short warm line ("Thanks for reaching out, Jeff.") and move to the substance.\n' +
      '- If you have a price to quote, quote it in the first paragraph. If you have a question, ask one (not three).\n' +
      '- This is about respecting the customer\'s time. Karenda is direct and warm. Caye should be the same.'
  }

  dynamic += '\n\nYou MUST end every turn by calling either send_reply or hold_for_human.'

  return { stable, dynamic }
}

interface AvailabilityRow {
  service_id: string | null
  booking_time: string
  number_of_people: number
  status: string
  service: { name: string; duration_minutes: number; is_shared: boolean; max_capacity: number }[] | null
}

interface AvailabilitySlot {
  time: string
  service: string | null
  service_id: string | null
  duration_minutes: number
  is_shared: boolean
  max_capacity: number | null
  total_guests: number
  capacity_remaining: number | null
  parties: Array<{ name?: string; guests: number }>
}

interface AvailabilityResult {
  date: string
  slots: AvailabilitySlot[]
  /** True when the business is closed that date (blackout). */
  closed?: boolean
  /** Human-readable closure label, e.g. "Holiday closure". */
  closed_label?: string
  /** True when that weekday is handled personally by the owner, not Caye. */
  owner_only?: boolean
}

async function checkAvailability(
  workspaceId: string,
  date: string
): Promise<AvailabilityResult> {
  const supabase = createServiceClient()

  // Operating rules first: a closed or owner-only date short-circuits before
  // we bother computing slot capacity. Caye must not quote/book on these.
  const { data: cfg } = await supabase
    .from('workspace_ai_config')
    .select('blackout_dates, owner_only_weekdays')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (cfg) {
    const verdict = evaluateOperatingDate(date, {
      blackout_dates: (cfg.blackout_dates as BlackoutRange[]) ?? [],
      owner_only_weekdays: (cfg.owner_only_weekdays as number[]) ?? [],
    })
    if (verdict.status === 'closed') {
      return { date, slots: [], closed: true, closed_label: verdict.label }
    }
    if (verdict.status === 'owner_only') {
      return { date, slots: [], owner_only: true }
    }
  }

  const { data, error } = await supabase
    .from('bookings')
    .select('service_id, customer_name, booking_time, number_of_people, status, service:booking_services(name, duration_minutes, is_shared, max_capacity)')
    .eq('user_id', workspaceId)
    .eq('booking_date', date)
    .neq('status', 'cancelled')
    .order('booking_time')

  if (error) {
    return { date, slots: [] }
  }

  // Group rows by (service_id, time) so shared slots aggregate
  type Key = string
  const groups = new Map<Key, { rows: (AvailabilityRow & { customer_name?: string })[]; svc?: AvailabilityRow['service'] }>()
  const rows = (data ?? []) as unknown as (AvailabilityRow & { customer_name?: string })[]
  for (const r of rows) {
    const k = `${r.service_id ?? 'none'}|${r.booking_time}`
    if (!groups.has(k)) groups.set(k, { rows: [], svc: r.service })
    groups.get(k)!.rows.push(r)
  }

  const slots: AvailabilitySlot[] = []
  for (const { rows, svc } of groups.values()) {
    const total = rows.reduce((a, b) => a + b.number_of_people, 0)
    const s = svc?.[0]
    const isShared = s?.is_shared ?? false
    const capacity = isShared ? s?.max_capacity ?? null : 1 // exclusive = 1 "slot"
    slots.push({
      time: rows[0].booking_time.slice(0, 5),
      service: s?.name ?? null,
      service_id: rows[0].service_id,
      duration_minutes: s?.duration_minutes ?? 120,
      is_shared: isShared,
      max_capacity: capacity,
      total_guests: total,
      capacity_remaining: capacity != null ? Math.max(0, capacity - total) : null,
      parties: rows.map(r => ({ name: r.customer_name, guests: r.number_of_people })),
    })
  }
  return { date, slots }
}

interface CreateBookingInput {
  customer_name: string
  customer_phone?: string
  customer_email?: string
  booking_date: string
  booking_time: string
  number_of_people?: number
  duration_minutes?: number
  service_id?: string
  notes?: string
  status?: 'confirmed' | 'pending'
}

/**
 * Fetch pricing tiers for a service and resolve the exact price for a group size.
 * Returns a structure Caye can quote verbatim, or a hold instruction.
 *
 * Deterministic — never paraphrases prices. The Stallings 2026-05-29 case
 * (see Clients/bimini-island-tours.md) traced to a human mis-typing pricing
 * by tier confusion; this function eliminates that class of error for Caye.
 */
async function lookupPriceForCaye(
  workspaceId: string,
  serviceId: string,
  groupSize: number
): Promise<
  | { ok: true; price_label: string; total_label: string; total_amount: number; tier_name: string }
  | { ok: false; hold: string; message: string }
> {
  const supabase = createServiceClient()

  // Verify the service belongs to this workspace before fetching tiers.
  const { data: service } = await supabase
    .from('booking_services')
    .select('id, user_id, name')
    .eq('id', serviceId)
    .eq('user_id', workspaceId)
    .maybeSingle()

  if (!service) {
    return {
      ok: false,
      hold: 'service_not_found',
      message: `Service ${serviceId} not found in this workspace. Pick a service_id from AVAILABLE SERVICES.`,
    }
  }

  const { data: tierRows, error } = await supabase
    .from('service_pricing_tiers')
    .select('id, tier_name, group_size_min, group_size_max, price_amount, price_label, is_flat, is_ambiguous_above, display_order')
    .eq('service_id', serviceId)
    .eq('workspace_id', workspaceId)
    .order('display_order', { ascending: true })

  if (error) {
    return { ok: false, hold: 'lookup_error', message: `Pricing lookup failed: ${error.message}` }
  }

  // price_amount comes back as string from postgres NUMERIC; coerce to number.
  const tiers: PricingTier[] = (tierRows ?? []).map(r => ({
    id: r.id,
    tier_name: r.tier_name,
    group_size_min: r.group_size_min,
    group_size_max: r.group_size_max,
    price_amount: typeof r.price_amount === 'string' ? parseFloat(r.price_amount) : r.price_amount,
    price_label: r.price_label,
    is_flat: r.is_flat,
    is_ambiguous_above: r.is_ambiguous_above,
    display_order: r.display_order,
  }))

  const result = resolveTier(tiers, groupSize)

  if (result.ok) {
    return {
      ok: true,
      price_label: result.priceLabel,
      total_label: result.totalLabel,
      total_amount: result.totalAmount,
      tier_name: result.tier.tier_name,
    }
  }

  return { ok: false, hold: result.hold, message: result.message }
}

async function createBookingFromCaye(
  workspaceId: string,
  conversationId: string | null,
  input: CreateBookingInput,
  fallbackEmail: string | null
): Promise<{ success: boolean; booking_id?: string; error?: string }> {
  const supabase = createServiceClient()

  const timeWithSeconds = input.booking_time.length === 5 ? `${input.booking_time}:00` : input.booking_time

  // Mark bookings created by Caye in the notes so the observability panel
  // can distinguish them from owner-created bookings. Cancels/reschedules
  // use the same pattern ([Caye cancel], [Caye reschedule]).
  const createNote = '[Caye create]'
  const trimmedInputNote = input.notes?.trim()
  const notesWithMarker = trimmedInputNote
    ? `${trimmedInputNote}\n\n${createNote}`
    : createNote

  const payload = {
    user_id: workspaceId,
    conversation_id: conversationId,
    service_id: input.service_id || null,
    customer_name: input.customer_name.trim(),
    customer_phone: input.customer_phone?.trim() || null,
    customer_email: input.customer_email?.trim() || fallbackEmail || null,
    booking_date: input.booking_date,
    booking_time: timeWithSeconds,
    number_of_people: input.number_of_people && input.number_of_people > 0 ? input.number_of_people : 1,
    duration_minutes:
      input.duration_minutes && input.duration_minutes > 0 ? input.duration_minutes : null,
    // Default to 'pending' (= tentative, customer hasn't confirmed details yet).
    // Caye must explicitly pass status='confirmed' when the customer has agreed
    // to a specific date/time AND availability has been verified. The Stallings
    // 2026-05-29 case showed why the default matters: a confirmed-on-inquiry
    // booking row created a phantom commitment before any customer agreement.
    // See _Ops/Brain/decisions-log.md and Clients/bimini-island-tours.md.
    status: input.status ?? 'pending',
    notes: notesWithMarker,
  }

  const { data, error } = await supabase.from('bookings').insert(payload).select('id').single()
  if (error || !data) {
    return { success: false, error: error?.message ?? 'Insert failed' }
  }
  return { success: true, booking_id: data.id }
}

export interface CayeAutoReplyInput {
  senderName: string
  body: string
  channel: 'whatsapp' | 'instagram' | 'messenger' | 'email'
  subject?: string
  isFirstMessage?: boolean
  workspaceId: string
  conversationId?: string | null
  senderEmail?: string | null
  /**
   * channel_message_id of the inbound message we're replying to.
   * Used to exclude the current message from the fetched history so we
   * don't echo it back as prior context.
   */
  currentChannelMessageId?: string | null
}

// ── find_bookings + cancel_booking ──────────────────────────────────────────

interface FoundBooking {
  booking_id: string
  customer_name: string
  service_name: string | null
  booking_date: string
  booking_time: string
  number_of_people: number
  status: string
  duration_minutes: number | null
}

interface FindBookingsResult {
  match_count: number
  bookings: FoundBooking[]
  /** Set when we fell back to name-match because email returned zero. Tells
   *  Caye to confirm with the customer before acting on a name-only hit. */
  matched_by: 'email' | 'name' | 'none'
}

/**
 * Look up active (confirmed/pending), future-dated bookings for a customer.
 * Email-first; name fallback only when email returns zero. The fallback
 * marker (`matched_by: 'name'`) tells Caye to verify before acting.
 */
async function findBookings(
  workspaceId: string,
  input: { customer_email?: string; customer_name?: string }
): Promise<FindBookingsResult> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const email = input.customer_email?.trim().toLowerCase()
  const name = input.customer_name?.trim()

  const selectCols =
    'id, customer_name, booking_date, booking_time, number_of_people, status, duration_minutes, ' +
    'service:booking_services(name)'

  type Row = {
    id: string
    customer_name: string
    booking_date: string
    booking_time: string
    number_of_people: number
    status: string
    duration_minutes: number | null
    service: { name: string }[] | null
  }

  let rows: Row[] = []
  let matched_by: 'email' | 'name' | 'none' = 'none'

  if (email) {
    const { data } = await supabase
      .from('bookings')
      .select(selectCols)
      .eq('user_id', workspaceId)
      .in('status', ['confirmed', 'pending'])
      .gte('booking_date', today)
      .ilike('customer_email', email)
      .order('booking_date')
      .order('booking_time')
    rows = (data ?? []) as unknown as Row[]
    if (rows.length) matched_by = 'email'
  }

  if (!rows.length && name) {
    const { data } = await supabase
      .from('bookings')
      .select(selectCols)
      .eq('user_id', workspaceId)
      .in('status', ['confirmed', 'pending'])
      .gte('booking_date', today)
      .ilike('customer_name', name)
      .order('booking_date')
      .order('booking_time')
    rows = (data ?? []) as unknown as Row[]
    if (rows.length) matched_by = 'name'
  }

  const bookings: FoundBooking[] = rows.map(r => ({
    booking_id: r.id,
    customer_name: r.customer_name,
    service_name: r.service?.[0]?.name ?? null,
    booking_date: r.booking_date,
    booking_time: r.booking_time.slice(0, 5),
    number_of_people: r.number_of_people,
    status: r.status,
    duration_minutes: r.duration_minutes,
  }))

  return { match_count: bookings.length, bookings, matched_by }
}

type CancelResult =
  | { ok: true; booking_id: string; hours_until_booking: number }
  | { ok: false; reason: 'within_policy_window' | 'booking_in_past' | 'not_found' | 'already_cancelled' | 'db_error'; detail?: string }

/**
 * Cancel an existing booking. Enforces the autonomy policy window
 * (defense in depth — the prompt also instructs Caye, but we don't trust
 * the prompt for irreversible operations). On success, syncs the Zoho
 * Calendar event delete in the background.
 */
async function cancelBookingFromCaye(
  workspaceId: string,
  bookingId: string,
  workspaceTimezone: string,
  reason: string | undefined
): Promise<CancelResult> {
  const supabase = createServiceClient()

  const { data: booking, error: readErr } = await supabase
    .from('bookings')
    .select('id, status, booking_date, booking_time, notes')
    .eq('id', bookingId)
    .eq('user_id', workspaceId)
    .maybeSingle()

  if (readErr || !booking) {
    return { ok: false, reason: 'not_found' }
  }
  if (booking.status === 'cancelled') {
    return { ok: false, reason: 'already_cancelled' }
  }

  const gate = checkBookingAutonomy({
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time.slice(0, 5),
    timezone: workspaceTimezone,
  })

  if (!gate.ok) {
    return { ok: false, reason: gate.reason, detail: `~${gate.hoursUntilBooking.toFixed(1)}h until booking` }
  }

  const cancellationNote = reason ? `[Caye cancel] ${reason}` : '[Caye cancel]'
  const noteWithReason = booking.notes
    ? `${booking.notes}\n\n${cancellationNote}`
    : cancellationNote

  const { error: updErr } = await supabase
    .from('bookings')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      notes: noteWithReason,
    })
    .eq('id', bookingId)

  if (updErr) {
    return { ok: false, reason: 'db_error', detail: updErr.message }
  }

  // Calendar delete fire-and-forget — booking is already cancelled in DB,
  // calendar sync failure is recoverable manually.
  syncBookingToCalendar(workspaceId, bookingId, 'delete').catch(err =>
    console.error('[caye-reply] cancel calendar sync failed:', err)
  )

  return { ok: true, booking_id: bookingId, hours_until_booking: gate.hoursUntilBooking }
}

// ── end find_bookings + cancel_booking ──────────────────────────────────────

// ── reschedule_booking ──────────────────────────────────────────────────────

type RescheduleResult =
  | {
      ok: true
      booking_id: string
      new_date: string
      new_time: string
      time_was_preserved: boolean
      hours_until_original_booking: number
    }
  | {
      ok: false
      reason:
        | 'within_policy_window'
        | 'booking_in_past'
        | 'not_found'
        | 'already_cancelled'
        | 'slot_unavailable'
        | 'db_error'
      detail?: string
    }

/**
 * Move an existing booking to a new date/time of the SAME service.
 *
 * Policy gate runs against the booking's CURRENT start (you can't sneak in
 * a reschedule on a booking that's 12h out). Availability check runs for
 * the new slot — exclusive-taken or shared-full rejects with
 * 'slot_unavailable' so Caye can suggest alternatives.
 *
 * Time-preservation default: if newTime is omitted, the booking's existing
 * time is used on the new date. The caller (Caye via the tool description)
 * is told to mention this in the reply.
 */
async function rescheduleBookingFromCaye(
  workspaceId: string,
  bookingId: string,
  newDate: string,
  newTime: string | undefined,
  newDurationMinutes: number | undefined,
  workspaceTimezone: string
): Promise<RescheduleResult> {
  const supabase = createServiceClient()

  // Pull the booking + its service config (capacity, sharing).
  type BookingRow = {
    id: string
    status: string
    booking_date: string
    booking_time: string
    number_of_people: number
    service_id: string | null
    duration_minutes: number | null
    notes: string | null
    service: { is_shared: boolean; max_capacity: number }[] | null
  }
  const { data: bookingRaw, error: readErr } = await supabase
    .from('bookings')
    .select(
      'id, status, booking_date, booking_time, number_of_people, service_id, ' +
        'duration_minutes, notes, ' +
        'service:booking_services(is_shared, max_capacity)'
    )
    .eq('id', bookingId)
    .eq('user_id', workspaceId)
    .maybeSingle()

  const booking = bookingRaw as unknown as BookingRow | null
  if (readErr || !booking) return { ok: false, reason: 'not_found' }
  if (booking.status === 'cancelled') return { ok: false, reason: 'already_cancelled' }

  // Policy gate against the CURRENT booking time. Prevents the move-then-cancel
  // loophole on near-term bookings.
  const gate = checkBookingAutonomy({
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time.slice(0, 5),
    timezone: workspaceTimezone,
  })
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason,
      detail: `~${gate.hoursUntilBooking.toFixed(1)}h until original booking`,
    }
  }

  // Default to existing time when the customer didn't specify a new one.
  const existingTime = booking.booking_time.slice(0, 5)
  const targetTime = (newTime ?? existingTime).slice(0, 5)
  const targetTimeWithSec = `${targetTime}:00`
  const time_was_preserved = !newTime || newTime === existingTime

  // No-op short-circuit: same date and same time = nothing to do.
  if (newDate === booking.booking_date && targetTime === existingTime) {
    return {
      ok: true,
      booking_id: bookingId,
      new_date: newDate,
      new_time: targetTime,
      time_was_preserved,
      hours_until_original_booking: gate.hoursUntilBooking,
    }
  }

  // Availability check at the new slot. Find conflicting bookings at the
  // SAME service + date + time, excluding the booking being rescheduled.
  const svc = booking.service?.[0]
  const isShared = svc?.is_shared ?? false
  const maxCapacity = svc?.max_capacity ?? 1

  if (booking.service_id) {
    const { data: conflicts } = await supabase
      .from('bookings')
      .select('id, number_of_people')
      .eq('user_id', workspaceId)
      .eq('booking_date', newDate)
      .eq('booking_time', targetTimeWithSec)
      .eq('service_id', booking.service_id)
      .neq('status', 'cancelled')
      .neq('id', bookingId)

    const others = (conflicts ?? []) as Array<{ id: string; number_of_people: number }>

    if (isShared) {
      const otherGuests = others.reduce((a, b) => a + b.number_of_people, 0)
      if (otherGuests + booking.number_of_people > maxCapacity) {
        return {
          ok: false,
          reason: 'slot_unavailable',
          detail: `shared slot has ${maxCapacity - otherGuests} seat(s) remaining, party is ${booking.number_of_people}`,
        }
      }
    } else if (others.length > 0) {
      return {
        ok: false,
        reason: 'slot_unavailable',
        detail: 'exclusive slot already booked',
      }
    }
  }

  const rescheduleNote = `[Caye reschedule] ${booking.booking_date} ${existingTime} → ${newDate} ${targetTime}`
  const noteWithLog = booking.notes
    ? `${booking.notes}\n\n${rescheduleNote}`
    : rescheduleNote

  const updates: Record<string, unknown> = {
    booking_date: newDate,
    booking_time: targetTimeWithSec,
    notes: noteWithLog,
  }
  if (newDurationMinutes && newDurationMinutes > 0) {
    updates.duration_minutes = newDurationMinutes
  }

  const { error: updErr } = await supabase
    .from('bookings')
    .update(updates)
    .eq('id', bookingId)

  if (updErr) return { ok: false, reason: 'db_error', detail: updErr.message }

  // Calendar upsert fire-and-forget — booking is already moved in DB,
  // calendar sync failure is recoverable manually.
  syncBookingToCalendar(workspaceId, bookingId, 'upsert').catch(err =>
    console.error('[caye-reply] reschedule calendar sync failed:', err)
  )

  return {
    ok: true,
    booking_id: bookingId,
    new_date: newDate,
    new_time: targetTime,
    time_was_preserved,
    hours_until_original_booking: gate.hoursUntilBooking,
  }
}

// ── end reschedule_booking ──────────────────────────────────────────────────

const HISTORY_LIMIT = 10

interface HistoryRow {
  sender_type: 'customer' | 'business'
  content: string | null
  sent_at: string
  channel_message_id: string | null
  metadata: Record<string, unknown> | null
}

/**
 * Pull the last N messages from this conversation so Caye sees what was
 * already said. Excludes the current inbound (by channel_message_id) so
 * it isn't echoed back as prior context.
 */
async function fetchConversationHistory(
  conversationId: string,
  excludeChannelMessageId: string | null
): Promise<HistoryRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('unified_messages')
    .select('sender_type, content, sent_at, channel_message_id, metadata')
    .eq('conversation_id', conversationId)
    .eq('is_internal', false)
    .order('sent_at', { ascending: false })
    .limit(HISTORY_LIMIT + 1)

  if (error || !data) return []

  const rows = data as HistoryRow[]
  const filtered = excludeChannelMessageId
    ? rows.filter(r => r.channel_message_id !== excludeChannelMessageId)
    : rows

  // Reverse to chronological order (oldest first) and cap at limit
  return filtered.slice(0, HISTORY_LIMIT).reverse()
}


/**
 * Core Caye auto-reply engine used by all channel webhooks.
 * Runs a tool-use loop so Caye can check availability and create bookings
 * before terminating with send_reply or hold_for_human.
 */
export async function generateCayeAutoReply(
  systemPrompt: string,
  inbound: CayeAutoReplyInput,
  voiceProfile?: VoiceProfile
): Promise<CayeAutoReply> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const isEmail = inbound.channel === 'email'

  // Pull services up front so Caye can reference them in the same turn.
  const supabase = createServiceClient()
  const { data: serviceRows } = await supabase
    .from('booking_services')
    .select('id, name, duration_minutes, description, is_shared, max_capacity, visibility')
    .eq('user_id', inbound.workspaceId)
    .eq('active', true)
    .order('name')

  const services = (serviceRows ?? []) as ServiceRow[]
  const todayISO = new Date().toISOString().slice(0, 10)

  // Fetch the workspace's business links + timezone in one query. Links
  // are non-fatal (empty = no BUSINESS LINKS block). Timezone is needed
  // for the cancel/reschedule policy gate so Caye doesn't misjudge the
  // 48h window for workspaces outside Nassau.
  let businessLinks: BusinessLinks | undefined
  let workspaceTimezone = 'America/Nassau' // sane default
  let voiceRegisterOverrides: Record<string, string> | null = null
  const { data: workspaceRow } = await supabase
    .from('customers')
    .select('booking_url, website_url, timezone, voice_register_overrides')
    .eq('id', inbound.workspaceId)
    .maybeSingle()
  if (workspaceRow) {
    if (workspaceRow.booking_url || workspaceRow.website_url) {
      businessLinks = {
        booking_url: workspaceRow.booking_url,
        website_url: workspaceRow.website_url,
      }
    }
    if (workspaceRow.timezone) workspaceTimezone = workspaceRow.timezone
    voiceRegisterOverrides =
      (workspaceRow.voice_register_overrides as Record<string, string> | null) ?? null
  }

  // If this conversation is linked to a contact, look up their style profile
  // + operational facts so Caye can mirror their energy AND avoid re-asking
  // for things already on file. Fetch is non-fatal.
  let contactProfile: ContactStyleProfile | undefined
  let contactFacts: CustomerFacts | undefined
  if (inbound.conversationId) {
    const { data: convRow } = await supabase
      .from('unified_conversations')
      .select('contact_id')
      .eq('id', inbound.conversationId)
      .maybeSingle()
    if (convRow?.contact_id) {
      const { data: contactRow } = await supabase
        .from('contacts')
        .select('ai_contact_profile, ai_contact_facts')
        .eq('id', convRow.contact_id)
        .maybeSingle()
      contactProfile =
        (contactRow?.ai_contact_profile as ContactStyleProfile | null) ?? undefined
      contactFacts =
        (contactRow?.ai_contact_facts as CustomerFacts | null) ?? undefined
    }
  }

  // Returning-customer history. Match on sender email + workspace. Skipped
  // entirely when we don't have an email (DM channels with no captured
  // address) — those contacts are handled when WhatsApp/IG/Messenger get
  // real per-workspace connections. Non-fatal on error: empty history just
  // means Caye treats them as a first-timer (the existing behaviour).
  let customerHistory: CustomerHistorySummary | undefined
  const lookupEmail = inbound.senderEmail?.trim().toLowerCase()
  if (lookupEmail) {
    const { data: bookingRows } = await supabase
      .from('bookings')
      .select('booking_date, status, number_of_people, service:booking_services(name)')
      .eq('user_id', inbound.workspaceId)
      .ilike('customer_email', lookupEmail)
    if (bookingRows && bookingRows.length > 0) {
      type Row = {
        booking_date: string
        status: string
        number_of_people: number
        service: { name: string }[] | null
      }
      const rows = bookingRows as unknown as Row[]
      const historyRows: BookingHistoryRow[] = rows.map(r => ({
        booking_date: r.booking_date,
        service_name: r.service?.[0]?.name ?? null,
        status: r.status,
        number_of_people: r.number_of_people,
      }))
      customerHistory = summarizeBookingHistory(historyRows)
    }
  }

  // Classify the inbound so buildSystem can append a situational tone
  // hint. Cheap regex/keyword pass — no API call. Returns null on
  // uncertainty (default tone takes over).
  const { category: inboundCategory } = classifyInbound(
    inbound.body,
    inbound.subject ?? ''
  )

  // Layer the voice register override (#54) onto the voice profile. b2b
  // override fires only for B2B-classified inbound; otherwise default.
  // Falls back to no override (cleanly null) when none is set.
  let effectiveVoiceProfile: VoiceProfile | undefined = voiceProfile
  if (voiceRegisterOverrides) {
    const scope: 'b2b' | 'default' =
      inboundCategory === 'b2b_partnership' && voiceRegisterOverrides.b2b
        ? 'b2b'
        : 'default'
    const override = voiceRegisterOverrides[scope]
    if (override) {
      effectiveVoiceProfile = {
        ...(voiceProfile ?? {
          writing_style: '',
          common_phrases: [],
          greeting_style: '',
          signoff_style: '',
          formality_level: 'warm-professional',
          tone_notes: '',
          signature_block: null,
          tagline: null,
          standard_signoff: null,
          standard_opener: null,
        }),
        register_override: override,
        register_scope: scope,
      }
    }
  }

  // Layer 1 confidence model (#57) — deterministic forced-escalation
  // triggers. If the inbound matches a known shape (complaint, B2B,
  // refund, custom request), skip the LLM entirely and return a
  // controlled-template escalation. Cheaper, faster, and removes any
  // chance Caye drafts something commercial she shouldn't.
  let forced: ForcedEscalation | null = detectForcedEscalation(inbound.body, inboundCategory)
  if (!forced) {
    // Hybrid sentiment cascade — Haiku second-pass when the keyword
    // classifier returned nothing OR landed on general_question (the
    // ambiguous bucket). We skip when the classifier is confident about
    // a non-complaint shape (booking_inquiry, gratitude, etc.) so we
    // don't pay for Haiku on every normal customer message. Matches the
    // cascade pattern from #47.
    const ambiguous =
      inboundCategory === null || inboundCategory === 'general_question'
    if (ambiguous) {
      const subtle = await detectSubtleComplaint(inbound.body, inbound.workspaceId)
      if (subtle) forced = buildSubtleComplaintEscalation(inbound.body)
    }
  }
  if (forced) {
    return {
      action: 'escalate',
      content: sanitizeDashes(forced.customerFacingMessage),
      category: forced.category,
      routeTo: forced.routeTo,
      internalContext: forced.internalContext,
      pingSummary: forced.pingSummary,
    }
  }

  // Pre-compute a deterministic service-name match. If the inbound body
  // contains an intake-form "Tour: <name>" line or a recognizable free-text
  // tour reference, run it against the canonical AVAILABLE SERVICES so the
  // LLM gets a strong hint about which service_id to use. Without this, name
  // mismatches like "North Bimini Historical Tour" (customer) vs "North
  // Bimini Heritage Tour" (catalog) cause Caye to DEFER instead of quote —
  // see Jeff Montenaro 2026-06-05 and James Stallings 2026-05-29.
  let serviceMatch: ServiceMatchResult | null = null
  const customerTourName = extractCustomerTourName(inbound.body)
  if (customerTourName && services.length > 0) {
    serviceMatch = matchServiceByName(
      services.map(s => ({ id: s.id, name: s.name })),
      customerTourName
    )
  }

  const businessFacts = await fetchBusinessFacts(inbound.workspaceId)

  const { stable: systemStable, dynamic: systemDynamic } = buildSystem(
    systemPrompt,
    effectiveVoiceProfile,
    contactProfile,
    contactFacts,
    businessLinks,
    customerHistory,
    inboundCategory,
    inbound.channel,
    isEmail,
    inbound.isFirstMessage ?? false,
    services,
    todayISO,
    serviceMatch,
    businessFacts
  )

  // Pull prior conversation history (if we have a conversation to query) so
  // Caye sees what was already said. Non-fatal — empty history just means
  // first message or a fetch failure.
  const history = inbound.conversationId
    ? await fetchConversationHistory(
        inbound.conversationId,
        inbound.currentChannelMessageId ?? null
      )
    : []
  const historyBlock = formatHistoryBlock(history)

  const newMessageBlock = isEmail
    ? `Reply to this email:\n\nFrom: ${inbound.senderName}\nSubject: ${inbound.subject || '(no subject)'}\n\n${inbound.body}`
    : `Reply to this ${inbound.channel} message:\n\nFrom: ${inbound.senderName}\n\n${inbound.body}`

  const userContent = `${historyBlock}${newMessageBlock}`

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }]

  let createdBookingId: string | undefined

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await loggedMessagesCreate(client, {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      // Two-block system: stable prefix cached at 1h TTL, dynamic suffix
      // (today's date, per-customer profile/history/facts, tone hint,
      // service-match hint, channel/first-message format rules) carried
      // uncached. The cached prefix bytes are stable across messages so
      // bursty traffic amortizes the cache write across many reads.
      // Locked 2026-06-24 (#46).
      system: [
        { type: 'text', text: systemStable, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: systemDynamic },
      ],
      tools: TOOLS,
      tool_choice: { type: 'any' },
      messages,
    }, { source: 'lib/caye-reply.ts:generateCayeAutoReply', workspaceId: inbound.workspaceId })

    messages.push({ role: 'assistant', content: response.content })

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )

    if (toolUses.length === 0) {
      const textBlock = response.content.find(b => b.type === 'text')
      if (textBlock && textBlock.type === 'text' && textBlock.text.trim()) {
        const leak = detectIdentityLeak(textBlock.text)
        if (leak) {
          console.warn(`[caye-reply] Identity guard blocked freeform reply: ${leak}`)
          return {
            action: 'hold',
            reason: `Identity guard: ${leak}`,
            note:
              `Caye drafted a reply (no tool call) but the identity guard blocked it (${leak}). ` +
              `Review the draft below and send manually if appropriate.\n\n---\n\n${textBlock.text}`,
          }
        }
        return { action: 'reply', content: sanitizeDashes(textBlock.text), bookingId: createdBookingId }
      }
      throw new Error('[caye-reply] No tool call or text in Claude response')
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let terminal: CayeAutoReply | null = null

    for (const tool of toolUses) {
      if (tool.name === 'send_reply') {
        const input = tool.input as {
          content: string
          flag_for_owner_followup?: boolean
          owner_note?: string
          confidence?: 'high' | 'medium' | 'low'
        }
        const leak = detectIdentityLeak(input.content)
        if (leak) {
          // Identity guard tripped — don't ship the reply. Hand to the owner
          // with the draft attached so they can decide.
          console.warn(`[caye-reply] Identity guard blocked reply: ${leak}`)
          terminal = {
            action: 'hold',
            reason: `Identity guard: ${leak}`,
            note:
              `Caye drafted a reply but the identity guard blocked it (${leak}). ` +
              `Review the draft below and send manually if appropriate.\n\n---\n\n${input.content}`,
          }
        } else if (input.confidence && input.confidence !== 'high') {
          // Layer 2 confidence model (#57) — medium/low confidence escalates
          // automatically. The drafted reply still ships to the customer (no
          // silent hold per spec) but the operator is pinged so they can
          // follow up before the customer hears back again. Category defaults
          // to 'knowledge' since send_reply confidence ≠ high typically means
          // Caye is unsure of a fact she stated.
          terminal = {
            action: 'escalate',
            content: sanitizeDashes(input.content),
            category: 'knowledge',
            routeTo: 'owner',
            internalContext:
              `Caye self-rated confidence=${input.confidence} on her reply. ` +
              `She sent it (per the Layer 2 spec, drafts ship even at medium/low) but the ` +
              `escalation is open so you can review and follow up if the answer needs ` +
              `correction.` +
              (input.owner_note?.trim()
                ? `\n\nCaye's note: ${input.owner_note.trim()}`
                : ''),
          }
        } else {
          const needsFollowup = !!input.flag_for_owner_followup
          terminal = {
            action: 'reply',
            content: sanitizeDashes(input.content),
            bookingId: createdBookingId,
            ...(needsFollowup
              ? {
                  needsOwnerFollowup: true,
                  ownerNote: input.owner_note?.trim() || 'Owner follow-up requested',
                }
              : {}),
          }
          // Acknowledge-and-defer (2B mode): flag the conversation in the
          // operator's attention queue so they see it even though Caye
          // replied autonomously. Best-effort — a flag failure should not
          // block the reply from going out.
          if (needsFollowup && inbound.conversationId) {
            try {
              const followupClient = createServiceClient()
              await followupClient
                .from('unified_conversations')
                .update({
                  human_agent_enabled: true,
                  human_agent_reason:
                    input.owner_note?.trim() || 'Caye acknowledged; owner decision needed.',
                  human_agent_marked_at: new Date().toISOString(),
                })
                .eq('id', inbound.conversationId)
            } catch (err) {
              console.error('[caye-reply] Failed to flag conversation for owner followup:', err)
            }
          }
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: 'ok' })
      } else if (tool.name === 'escalate_to_team') {
        const input = tool.input as {
          category: EscalationCategory
          route_to: EscalationRouteTo
          customer_facing_message: string
          internal_context: string
        }
        // Same identity guard as send_reply — the customer-facing message
        // ships verbatim, so it must clear the AI-identity sniff.
        const leak = detectIdentityLeak(input.customer_facing_message)
        if (leak) {
          console.warn(`[caye-reply] Identity guard blocked escalation: ${leak}`)
          terminal = {
            action: 'hold',
            reason: `Identity guard: ${leak}`,
            note:
              `Caye tried to escalate (${input.category} → ${input.route_to}) but the ` +
              `identity guard blocked the customer message (${leak}). Review the draft ` +
              `below and send manually if appropriate.\n\n---\n\nCustomer-facing draft:\n` +
              `${input.customer_facing_message}\n\n---\n\nInternal context:\n${input.internal_context}`,
          }
        } else {
          terminal = {
            action: 'escalate',
            content: sanitizeDashes(input.customer_facing_message),
            category: input.category,
            routeTo: input.route_to,
            internalContext: input.internal_context,
          }
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: 'ok' })
      } else if (tool.name === 'hold_for_human') {
        const input = tool.input as {
          reason: string
          note: string
          proposed_reply?: string
          customer_acknowledgement?: string
        }
        const draft = input.proposed_reply?.trim() || undefined
        // Identity guard the proposed draft too — never surface a draft that
        // would have been blocked from sending.
        const draftLeak = draft ? detectIdentityLeak(draft) : null

        // Customer-facing acknowledgement (receptionist-spec Q7): warm
        // one-liner sent immediately so the customer hears something
        // while the held thread waits on the operator. Same identity
        // guard as the proposed draft — if it leaks Caye's AI identity
        // it gets dropped silently rather than sent.
        const ackRaw = input.customer_acknowledgement?.trim()
        const ack = ackRaw && ackRaw.length > 0 ? ackRaw : undefined
        const ackLeak = ack ? detectIdentityLeak(ack) : null
        const safeAck = ackLeak ? undefined : ack

        terminal = {
          action: 'hold',
          reason: input.reason,
          note: input.note,
          proposedReply: draftLeak ? undefined : draft,
          customerAcknowledgement: safeAck,
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: 'ok' })
      } else if (tool.name === 'check_availability') {
        const input = tool.input as { date: string }
        const result = await checkAvailability(inbound.workspaceId, input.date)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        })
      } else if (tool.name === 'lookup_price') {
        const input = tool.input as { service_id: string; group_size: number }
        const result = await lookupPriceForCaye(
          inbound.workspaceId,
          input.service_id,
          input.group_size
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        })
      } else if (tool.name === 'create_booking') {
        const input = tool.input as CreateBookingInput
        const result = await createBookingFromCaye(
          inbound.workspaceId,
          inbound.conversationId ?? null,
          input,
          inbound.senderEmail ?? null
        )
        if (result.success && result.booking_id) createdBookingId = result.booking_id
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
          is_error: !result.success,
        })
      } else if (tool.name === 'find_bookings') {
        const input = tool.input as { customer_email?: string; customer_name?: string }
        const result = await findBookings(inbound.workspaceId, input)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        })
      } else if (tool.name === 'cancel_booking') {
        const input = tool.input as { booking_id: string; reason?: string }
        const result = await cancelBookingFromCaye(
          inbound.workspaceId,
          input.booking_id,
          workspaceTimezone,
          input.reason
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        })
      } else if (tool.name === 'reschedule_booking') {
        const input = tool.input as {
          booking_id: string
          new_date: string
          new_time?: string
          duration_minutes?: number
        }
        const result = await rescheduleBookingFromCaye(
          inbound.workspaceId,
          input.booking_id,
          input.new_date,
          input.new_time,
          input.duration_minutes,
          workspaceTimezone
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        })
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: `Unknown tool: ${tool.name}`,
          is_error: true,
        })
      }
    }

    if (terminal) return terminal

    messages.push({ role: 'user', content: toolResults })
  }

  throw new Error('[caye-reply] Max tool rounds exceeded without send_reply or hold_for_human')
}
