/**
 * Operator brief composer — turns an escalated customer thread into the
 * message the operator actually reads.
 *
 * WHY THIS EXISTS (2026-08-07)
 * Before this, an escalation reached the operator as one of two hardcoded
 * format strings in the outbound worker, built from a 100-character slice
 * of the raw inbound body. A live web-form booking (Robert, 2026-08-06)
 * arrived as:
 *
 *   Reason: Custom request — "Name: Robert Email: Carron12321@gmail.com
 *   Phone: 5738038725 Guests: 5 Age Range: Mixed Ages Date: Mo"
 *
 * The slice died at character 100, mid-word, with no ellipsis — so the
 * tour date, the tour type, and the entire Notes field (a guest with
 * limited mobility, which is what actually decides whether the tour can
 * run) never reached the owner. The operator got a machine payload and no
 * decision.
 *
 * DELIBERATELY NOT LLM-DRIVEN. Six of the seven lines in the target
 * message are pure data rendering; the only judgment is the closing ask,
 * which is a per-trigger locked string. Keeping it deterministic means no
 * token cost on a high-frequency path, no drift, and full unit coverage —
 * the same reasoning behind the locked TEMPLATES enum in
 * lib/forced-escalation.ts.
 *
 * NO PRONOUNS FOR THE CUSTOMER. Composed text refers to the customer by
 * name, never "he"/"she" — the intake form carries a name, never a
 * gender, and guessing wrong in a message the owner may forward is worse
 * than repeating the name.
 */

// Type-only import — erased at compile time, so this doesn't create a real
// runtime cycle even though forced-escalation.ts imports buildCustomerRecap
// from this module. Kept as the same type (not a re-declared duplicate) so
// the two can never drift apart.
import type { ForcedTrigger } from './forced-escalation'
import { detectInternalLeak } from './operator-text-guard'

export interface BriefField {
  label: string
  value: string
}

export type BriefTrigger = ForcedTrigger

export interface OperatorBriefInput {
  /** Forced-escalation trigger. Null for LLM-driven escalate_to_team. */
  trigger: BriefTrigger | null
  contactName: string
  /** Raw inbound body. Web-form submissions arrive as "Label: value" lines
   *  (see buildWeb3FormsContext) and are parsed structurally; anything else
   *  is treated as prose. */
  body: string
  /** What Caye already sent the customer on this thread, if anything. */
  alreadySent?: string | null
  /** Calendar read for the requested date. Undefined = not looked up;
   *  null = looked up and unavailable (query failed). */
  availability?: { dateISO: string; bookingCount: number } | null
  /** Operator-ready prose from the LLM path, used when there's no trigger. */
  internalContext?: string | null
}

export interface OperatorBrief {
  /** Multi-line message for free-form WhatsApp + the Caye Direct thread. */
  brief: string
  /** Single-line, newline-free, template-parameter safe. Meta rejects
   *  template params containing newlines, tabs, or 4+ consecutive spaces. */
  oneLine: string
  /** ISO date parsed from the structured fields, when present. */
  targetDate: string | null
}

// Meta's template parameters have no hard documented length cap, but a
// reason line past this stops being scannable on a lock screen.
const ONE_LINE_MAX = 160

// ── Field label aliases ────────────────────────────────────────────────────
// Intake forms use whatever labels the business chose. These map the
// handful of fields the brief renders specially; every other field falls
// through to the "other details" block with its original label intact.
const ALIASES: Record<string, string[]> = {
  name: ['name', 'your name', 'full name', 'customer name', 'first name'],
  email: ['email', 'email address', 'your email', 'customer email'],
  phone: ['phone', 'phone number', 'contact number', 'mobile', 'cell'],
  guests: ['guests', 'number of guests', 'party size', 'group size', 'people'],
  date: ['date', 'preferred date', 'tour date', 'requested date'],
  dateISO: ['dateiso'],
  service: ['tour', 'tour type', 'service', 'package', 'experience'],
  notes: [
    'notes',
    'message',
    'comments',
    'additional info',
    'additional information',
    'special requests',
    'details',
  ],
}

/**
 * Parse a "Label: value" body into ordered fields. Returns null when the
 * body doesn't look like a form submission — the bar is at least three
 * labelled lines, so a prose email that happens to contain one colon
 * doesn't get mangled into a fake form.
 */
export function parseLabelledFields(body: string): BriefField[] | null {
  if (!body) return null
  const fields: BriefField[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^([A-Za-z][A-Za-z0-9 _/'-]{0,40}?)\s*:\s*(.+)$/)
    if (!match) {
      // A non-labelled line after fields have started means this is prose
      // with a colon in it, not a form. Bail rather than guess.
      if (fields.length > 0) return null
      continue
    }
    fields.push({ label: match[1].trim(), value: match[2].trim() })
  }
  return fields.length >= 3 ? fields : null
}

function pick(fields: BriefField[], key: keyof typeof ALIASES): string | null {
  const aliases = ALIASES[key]
  for (const f of fields) {
    if (aliases.includes(f.label.toLowerCase().replace(/\s+/g, ' '))) {
      const v = f.value.trim()
      if (v) return v
    }
  }
  return null
}

function isKnownLabel(label: string): boolean {
  const normalized = label.toLowerCase().replace(/\s+/g, ' ')
  return Object.values(ALIASES).some((list) => list.includes(normalized))
}

/**
 * The intake form's fields, resolved through ALIASES into the handful that
 * actually drive a decision. Shared by the operator brief and by the
 * back-office read tools (get_customer), so a form label only has to be
 * taught to ALIASES once.
 */
export interface IntakeSummary {
  name: string | null
  email: string | null
  phone: string | null
  guests: string | null
  date: string | null
  dateISO: string | null
  service: string | null
  notes: string | null
  /** Fields the form asked that aren't one of the known labels above. */
  extras: BriefField[]
}

/** Resolve parsed form fields into the known intake fields. */
export function summarizeIntake(fields: BriefField[]): IntakeSummary {
  return {
    name: pick(fields, 'name'),
    email: pick(fields, 'email'),
    phone: pick(fields, 'phone'),
    guests: pick(fields, 'guests'),
    date: pick(fields, 'date'),
    dateISO: pick(fields, 'dateISO'),
    service: pick(fields, 'service'),
    notes: pick(fields, 'notes'),
    extras: fields.filter((f) => !isKnownLabel(f.label) && f.value),
  }
}

/** Parse a raw form-shaped body straight into an IntakeSummary. Null when
 *  the body isn't a parseable form submission. */
export function summarizeIntakeBody(body: string): IntakeSummary | null {
  const fields = parseLabelledFields(body)
  return fields ? summarizeIntake(fields) : null
}

/** "2026-08-31" → "Mon 8/31". Falls back to the raw string when unparseable. */
export function shortDate(dateISO: string): string {
  const m = dateISO.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return dateISO
  const d = new Date(`${dateISO}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return dateISO
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  return `${day} ${Number(m[2])}/${Number(m[3])}`
}

/** "2026-08-31" → "Monday, August 31" — customer-facing, no year (matches
 *  the intake form's own "Monday, August 31, 2026" style minus the year,
 *  which reads as slightly stiff in a chat reply). */
export function longDate(dateISO: string): string {
  const d = new Date(`${dateISO}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return dateISO
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/** Collapse whitespace and cut at a word boundary with a real ellipsis. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

// Per-trigger closing ask. Locked strings — this is the one line in the
// brief that carries judgment, and it stays a controlled enum rather than
// something a model rewrites each time.
const CLOSING_ASK: Record<BriefTrigger, string> = {
  custom_request:
    'Two things from you: can you run it that day, and what should I quote? Send me those and I\'ll write back.',
  b2b_partnership:
    'Your call on whether to take this on. Tell me yes or no and how you want it priced, and I\'ll reply.',
  refund:
    'Your call. Tell me what to offer and I\'ll send it.',
  complaint:
    'Want me to draft an apology and a make-good, or do you want to take this one yourself?',
}

// Opening line by trigger — names what landed, not the internal taxonomy.
const OPENING: Record<BriefTrigger, string> = {
  custom_request: 'Booking request off the website — this one needs you.',
  b2b_partnership: 'B2B enquiry — needs your call.',
  refund: 'Refund request — needs your call.',
  complaint: 'Complaint came in — needs your call.',
}

/**
 * Compose the operator-facing brief.
 *
 * Structured (form) path renders the facts in decision order: what/when,
 * calendar, the free-text note that decides it, how to reach them, what
 * the customer has already been told, and one closing ask.
 *
 * Prose path falls back to the LLM's internalContext, which the
 * escalate_to_team contract already specifies as an operator-ready handoff
 * ending in a concrete yes/no proposal.
 */
export function buildOperatorBrief(input: OperatorBriefInput): OperatorBrief {
  const fields = parseLabelledFields(input.body)
  const who = input.contactName?.trim() || 'A guest'

  if (!fields) return buildProseBrief(input, who)

  const dateISO = pick(fields, 'dateISO')
  const dateLabel = pick(fields, 'date')
  const guests = pick(fields, 'guests')
  const service = pick(fields, 'service')
  const notes = pick(fields, 'notes')
  const phone = pick(fields, 'phone')
  const email = pick(fields, 'email')

  const targetDate = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : null
  const whenShort = targetDate ? shortDate(targetDate) : dateLabel

  // Standard booking-line shape from the back-office house style:
  // date · name · party-size · type. Fields that don't apply are skipped
  // rather than padded.
  const headline = [
    whenShort,
    who,
    guests ? `${guests} guests` : null,
    service,
  ]
    .filter(Boolean)
    .join(' · ')

  const lines: string[] = []
  lines.push(input.trigger ? OPENING[input.trigger] : `${who} needs your call.`)
  lines.push('')
  if (headline) lines.push(headline)

  // Calendar context — answers the operator's first question before it's
  // asked. Only rendered when we actually looked the date up.
  if (targetDate && input.availability) {
    lines.push(
      input.availability.bookingCount === 0
        ? "Calendar's clear that day."
        : `Already ${input.availability.bookingCount} on the calendar that day.`
    )
  }

  // The free-text note is the highest-value field in a form submission and
  // the one most likely to change the answer. Quoted verbatim — these are
  // the customer's own words.
  if (notes) {
    lines.push('')
    lines.push(`What decides it: "${notes}"`)
  }

  // Anything the form asked that isn't already rendered above.
  const extras = fields.filter((f) => !isKnownLabel(f.label) && f.value)
  if (extras.length > 0) {
    lines.push('')
    for (const f of extras) lines.push(`${f.label}: ${f.value}`)
  }

  const contact = [phone, email].filter(Boolean).join(' or ')
  if (contact) {
    lines.push('')
    lines.push(`Reach ${who} at ${contact}.`)
  }

  if (input.alreadySent) {
    lines.push('')
    lines.push(
      `So far ${who} has only had a holding line from me — ${truncate(input.alreadySent, 120)} Nothing promised on price or availability.`
    )
  }

  lines.push('')
  lines.push(input.trigger ? CLOSING_ASK[input.trigger] : "Tell me how to handle it and I'll take it from here.")

  // Template fallback line — same facts, one line, no newlines.
  const oneLineParts = [
    input.trigger === 'custom_request' ? 'Booking request' : null,
    headline || null,
  ].filter(Boolean)
  const oneLine = truncate(
    oneLineParts.length > 0 ? oneLineParts.join(' — ') : `${who} needs your call`,
    ONE_LINE_MAX
  )

  return { brief: lines.join('\n'), oneLine, targetDate }
}

// How much of a prose inbound to quote into the brief. Long enough to carry a
// real B2B/complaint email's actual ask, short enough to stay scannable on a
// phone. truncate() cuts at a word boundary with a real ellipsis.
const INBOUND_QUOTE_MAX = 400

/**
 * The customer's own message, attributed by name and quoted verbatim. Named
 * rather than pronouned, per this module's no-guessed-pronouns rule.
 */
function quoteInbound(body: string, who: string): string {
  const flat = truncate(body ?? '', INBOUND_QUOTE_MAX)
  return flat ? `${who} wrote: "${flat}"` : ''
}

/**
 * Prose fallback — no parseable form.
 *
 * WHICH FIELD CARRIES THE BRIEF DEPENDS ON THE PATH, and getting this wrong
 * is what put a machine payload in an owner's WhatsApp (Ruslan Prakapovich,
 * 2026-08-07). `trigger` is the discriminator, and it's exact: triggerHint is
 * set in precisely one place (lib/caye-reply.ts, from forced.trigger), so
 *
 *   trigger === null  → LLM escalate_to_team path. internalContext is
 *                       operator-ready prose by contract — it carries the brief.
 *   trigger !== null  → forced escalation, LLM skipped entirely.
 *                       internalContext is machine-composed diagnostics
 *                       ("Forced escalation — b2b_partnership (inbound
 *                       classifier — …). Owner: review the thread…") written
 *                       for the dashboard internal note. NEVER show it.
 *
 * On the forced path the operator needs the customer's actual words, so the
 * body carries the brief instead — the OPENING and CLOSING_ASK enums already
 * supply every bit of framing internalContext was being mined for.
 */
function buildProseBrief(input: OperatorBriefInput, who: string): OperatorBrief {
  let core = (
    input.trigger ? quoteInbound(input.body, who) : (input.internalContext ?? input.body ?? '')
  ).trim()

  // Backstop. The discriminator above is exact today, but this brief goes
  // straight to an operator's WhatsApp — irreversible in the way that matters,
  // since "we fixed the composer" doesn't unsend a machine payload. So a core
  // that still carries internal machinery gets dropped rather than sent, and
  // falls back to the customer's own words. Loud, because reaching this means
  // an upstream contract broke and the structural fix needs revisiting.
  const leak = detectInternalLeak(core)
  if (leak) {
    console.error(`[operator-brief] internal text in brief core (${leak}) — using inbound quote instead`)
    const fallback = quoteInbound(input.body, who)
    core = detectInternalLeak(fallback) ? '' : fallback
  }

  const lines: string[] = []

  lines.push(input.trigger ? OPENING[input.trigger] : `${who} needs your call.`)
  if (core) {
    lines.push('')
    lines.push(core)
  }
  if (input.availability) {
    lines.push('')
    lines.push(
      input.availability.bookingCount === 0
        ? `Calendar's clear on ${shortDate(input.availability.dateISO)}.`
        : `Already ${input.availability.bookingCount} on the calendar ${shortDate(input.availability.dateISO)}.`
    )
  }
  if (input.alreadySent) {
    lines.push('')
    lines.push(
      `So far ${who} has only had a holding line from me — ${truncate(input.alreadySent, 120)} Nothing promised on price or availability.`
    )
  }
  if (input.trigger) {
    lines.push('')
    lines.push(CLOSING_ASK[input.trigger])
  }

  const oneLine = truncate(core || `${who} needs your call`, ONE_LINE_MAX)
  return { brief: lines.join('\n'), oneLine, targetDate: null }
}

/**
 * Deterministic recap appended to the customer-facing controlled template
 * for a forced escalation. Purely additive — the locked stem in
 * TEMPLATES stays the customer's first sentence unchanged; this proves the
 * details were actually read instead of leaving a customer who just filled
 * in nine fields wondering if any of them landed.
 *
 * Deliberately does NOT paraphrase or interpret the notes field (e.g. does
 * not infer "accessibility need" from "limited in walking") — it quotes the
 * customer's own words back verbatim. Interpreting free text for a
 * customer-facing send is exactly the kind of judgment call this module
 * exists to avoid; paraphrasing risk (get the interpretation wrong, in a
 * message with the business's name on it) outweighs the small polish gain.
 *
 * Returns null when the body isn't a parseable form (nothing to recap) or
 * a form with nothing beyond a bare name (nothing recap-worthy).
 */
export function buildCustomerRecap(body: string): string | null {
  const fields = parseLabelledFields(body)
  if (!fields) return null

  const dateISO = pick(fields, 'dateISO')
  const dateLabel = pick(fields, 'date')
  const guests = pick(fields, 'guests')
  const service = pick(fields, 'service')
  const notes = pick(fields, 'notes')

  const when = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? longDate(dateISO) : dateLabel

  const headline = [when, service, guests ? `for ${guests}` : null].filter(Boolean).join(', ')
  if (!headline && !notes) return null

  const sentences: string[] = []
  if (headline) sentences.push(`Got it — ${headline}.`)
  if (notes) {
    sentences.push(
      `Noted: "${truncate(notes, 200)}" — I've passed that along so it's factored in before anything's confirmed.`
    )
  }
  return sentences.join(' ')
}
