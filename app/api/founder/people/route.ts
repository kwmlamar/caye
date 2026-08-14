/**
 * GET /api/founder/people?workspaceId=<uuid>[&id=<personId>]
 *
 * Backs the People page — replaces /api/founder/contacts (still present,
 * unused by any UI now) with a route that returns ONE normalized `Person`
 * shape regardless of what kind of workspace this is, because the two
 * underlying models genuinely don't share an identity:
 *
 *   - Customer-facing workspaces: contacts (+ bookings, joined via
 *     unified_conversations.contact_id).
 *   - internal_sales (TropiTech's own cold-outreach workspace): outreach_
 *     leads, identified by lead_email — confirmed live that
 *     unified_conversations.contact_id is 0/165 populated here, so contacts
 *     cannot be used for this workspace at all.
 *
 * Prospect relationship state and next-action defer entirely to
 * lib/sales/funnel.ts + lib/sales/next-action.ts (via lib/people.ts's
 * deriveProspect) — this route's job is only to gather the real evidence
 * those functions need (a live reply-detection join, unanswered-reply
 * state, queue-hold/review state), not to make any funnel decision itself.
 *
 * Needs You reuses the exact Inbox/Home definition (conversationNeedsFounder
 * — human_agent_enabled AND not a queue hold), so a person flagged "Needs
 * you" here always matches what Inbox's Needs You tab would show for their
 * conversation.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'
import { conversationNeedsFounder, cleanHoldReason, isQueueHold, holdKindOf } from '@/lib/hold-kinds-shared'
import {
  deriveProspect, deriveCustomer, describeProspectUnderstanding, describeCustomerUnderstanding,
  customerKnownFacts, prospectKnownFacts, type PersonSummary, type PersonDetail, type ProspectInput,
  type CustomerInput, type PersonFacts,
} from '@/lib/people'
import { recentSignalsFor } from '@/lib/sales/signals'
import { hasSalesCapability } from '@/lib/sales/capability'

type ServiceClient = ReturnType<typeof createServiceClient>

const LIST_CAP = 500

interface ConvLite {
  id: string
  human_agent_enabled: boolean
  human_agent_reason: string | null
  metadata: unknown
  last_message_at: string | null
  last_sender_type: string | null
  contact_id: string | null
  customer_id: string
}

async function connectedAccountIds(supabase: ServiceClient, workspaceId: string): Promise<string[]> {
  const { data } = await supabase.from('connected_accounts').select('id').eq('user_id', workspaceId)
  return (data ?? []).map((a) => a.id as string)
}

function needsYouFor(conv: ConvLite | undefined): { needsYou: boolean; reason: string | null } {
  if (!conv) return { needsYou: false, reason: null }
  const needsYou = conversationNeedsFounder(conv)
  return { needsYou, reason: needsYou ? cleanHoldReason(conv.human_agent_reason) : null }
}

/** Drafted outreach parked for batch approval (a QUEUE hold — see
 *  hold-kinds-shared.ts) — distinct from needsYou, which conversationNeedsFounder
 *  deliberately excludes queue holds from. */
function awaitingReviewFor(conv: ConvLite | undefined): boolean {
  return !!conv && conv.human_agent_enabled && isQueueHold(holdKindOf(conv.metadata))
}

// ── Prospects (internal_sales) ──────────────────────────────────────────────

interface LeadRow {
  id: string
  lead_email: string
  business_name: string | null
  contact_name: string | null
  stage: string
  qualified_at: string | null
  first_touch_sent_at: string | null
  touches_sent: number
  last_touch_sent_at: string | null
  opted_out_at: string | null
  last_inbound_kind: 'human_reply' | 'automated_ooo' | 'opt_out' | 'bounce_or_delivery_failure' | 'unknown' | null
  disqualified_reason: string | null
  status: string
  tried_at: string | null
  created_at: string
}

async function fetchOutreachContext(supabase: ServiceClient, accountIds: string[], emails: string[]) {
  const convByEmail = new Map<string, ConvLite>()
  if (accountIds.length === 0 || emails.length === 0) return { convByEmail }

  const { data: convs } = await supabase
    .from('unified_conversations')
    .select('id, customer_id, human_agent_enabled, human_agent_reason, metadata, last_message_at, last_sender_type')
    .in('connected_account_id', accountIds)
    .in('customer_id', emails)
    .order('last_message_at', { ascending: false, nullsFirst: false })

  for (const c of (convs ?? []) as (ConvLite & { customer_id: string })[]) {
    // A lead can end up with more than one conversation row (first-touch +
    // a later follow-up that failed to find it, see outreach-autosend-scan's
    // own fallback insert) — first one wins under the most-recent ordering.
    if (!convByEmail.has(c.customer_id)) convByEmail.set(c.customer_id, c)
  }

  return { convByEmail }
}

function prospectInputFor(lead: LeadRow, conv: ConvLite | undefined): ProspectInput {
  const { needsYou } = needsYouFor(conv)
  return {
    stage: lead.stage,
    qualified_at: lead.qualified_at,
    status: lead.status,
    opted_out_at: lead.opted_out_at,
    last_inbound_kind: lead.last_inbound_kind,
    disqualified_reason: lead.disqualified_reason,
    first_touch_sent_at: lead.first_touch_sent_at,
    touches_sent: lead.touches_sent,
    last_touch_sent_at: lead.last_touch_sent_at,
    tried_at: lead.tried_at,
    created_at: lead.created_at,
    has_replied: lead.last_inbound_kind === 'human_reply',
    has_unanswered_reply: lead.last_inbound_kind === 'human_reply' && conv?.last_sender_type === 'customer',
    has_unclassified_inbound: !lead.last_inbound_kind && conv?.last_sender_type === 'customer',
    awaiting_review: awaitingReviewFor(conv),
    needsYou,
  }
}

function prospectSummary(lead: LeadRow, conv: ConvLite | undefined, now: Date): PersonSummary {
  const { needsYou, reason } = needsYouFor(conv)
  const input = prospectInputFor(lead, conv)
  const d = deriveProspect(input, now)
  return {
    id: lead.id,
    kind: 'prospect',
    name: lead.contact_name || lead.business_name || lead.lead_email,
    company: lead.business_name,
    channel: 'email',
    email: lead.lead_email,
    phone: null,
    state: d.state,
    stateLabel: d.stateLabel,
    rowContext: d.rowContext,
    nextAction: d.nextAction,
    needsYou,
    needsYouReason: reason,
    lastInteractionAt: conv?.last_message_at ?? lead.last_touch_sent_at ?? lead.first_touch_sent_at ?? lead.created_at,
    conversationId: conv?.id ?? null,
  }
}

async function loadProspectList(supabase: ServiceClient, workspaceId: string): Promise<PersonSummary[]> {
  const [{ data: leads }, accountIds] = await Promise.all([
    supabase
      .from('outreach_leads')
      .select('id, lead_email, business_name, contact_name, stage, qualified_at, first_touch_sent_at, touches_sent, last_touch_sent_at, opted_out_at, last_inbound_kind, disqualified_reason, status, tried_at, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(LIST_CAP),
    connectedAccountIds(supabase, workspaceId),
  ])

  const rows = (leads ?? []) as LeadRow[]
  const { convByEmail } = await fetchOutreachContext(supabase, accountIds, rows.map((l) => l.lead_email))
  const now = new Date()

  return rows.map((lead) => {
    const conv = convByEmail.get(lead.lead_email)
    return prospectSummary(lead, conv, now)
  })
}

async function loadProspectDetail(supabase: ServiceClient, workspaceId: string, id: string): Promise<PersonDetail | null> {
  const { data: lead } = await supabase
    .from('outreach_leads')
    .select('id, lead_email, business_name, contact_name, stage, qualified_at, first_touch_sent_at, touches_sent, last_touch_sent_at, opted_out_at, last_inbound_kind, disqualified_reason, status, tried_at, created_at')
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle()
  if (!lead) return null

  const accountIds = await connectedAccountIds(supabase, workspaceId)
  const { convByEmail } = await fetchOutreachContext(supabase, accountIds, [lead.lead_email])
  const conv = convByEmail.get(lead.lead_email)
  const now = new Date()

  const input = prospectInputFor(lead, conv)
  const summary = prospectSummary(lead, conv, now)
  const name = summary.name
  const signals = await recentSignalsFor(lead.id)

  const history: { at: string; label: string }[] = [
    { at: lead.created_at, label: 'Caye sourced this prospect' },
  ]
  if (lead.first_touch_sent_at) history.push({ at: lead.first_touch_sent_at, label: 'First outreach sent' })
  if (lead.touches_sent >= 2 && lead.last_touch_sent_at) {
    history.push({ at: lead.last_touch_sent_at, label: `Follow-up ${lead.touches_sent - 1} sent` })
  }
  if (lead.tried_at) history.push({ at: lead.tried_at, label: 'Tried the Caye demo' })
  if (lead.opted_out_at) history.push({ at: lead.opted_out_at, label: 'Opted out' })
  history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  return {
    ...summary,
    understanding: describeProspectUnderstanding(name, input, now),
    current: deriveProspect(input, now).current,
    knownFacts: prospectKnownFacts(signals),
    history,
    // Sourcing captures no per-lead qualification signal today (see
    // lib/people.ts's doc comment) — the only honest, non-fabricated claim
    // is that this row came from the autonomous sourcing program at all.
    whyFound: 'Sourced through Caye\'s autonomous Caribbean hospitality/tour-operator outreach program.',
    conversionValue: null,
  }
}

// ── Customers (contacts) ────────────────────────────────────────────────────

interface ContactRow {
  id: string
  name: string | null
  phone_number: string | null
  email: string | null
  channel_type: string | null
  last_message_at: string | null
  is_blocked: boolean
  opted_out: boolean
  ai_contact_profile: { formality: string; message_style: string; language_notes: string } | null
  ai_contact_facts: PersonFacts | null
}

interface BookingLite {
  conversation_id: string | null
  booking_date: string
  number_of_people: number
  service_name: string | null
}

async function fetchContactContext(supabase: ServiceClient, accountIds: string[], contactIds: string[]) {
  const convsByContact = new Map<string, ConvLite[]>()
  const bookingsByContact = new Map<string, BookingLite[]>()
  if (accountIds.length === 0 || contactIds.length === 0) return { convsByContact, bookingsByContact }

  const { data: convs } = await supabase
    .from('unified_conversations')
    .select('id, contact_id, human_agent_enabled, human_agent_reason, metadata, last_message_at')
    .in('connected_account_id', accountIds)
    .in('contact_id', contactIds)

  const convIdToContact = new Map<string, string>()
  for (const c of (convs ?? []) as (ConvLite & { contact_id: string })[]) {
    const list = convsByContact.get(c.contact_id) ?? []
    list.push(c)
    convsByContact.set(c.contact_id, list)
    convIdToContact.set(c.id, c.contact_id)
  }

  const convIds = Array.from(convIdToContact.keys())
  if (convIds.length > 0) {
    const { data: bookingRows } = await supabase
      .from('bookings')
      .select('conversation_id, booking_date, number_of_people, status, service:booking_services(name)')
      .in('conversation_id', convIds)
      .neq('status', 'cancelled')
      .order('booking_date', { ascending: true })

    for (const b of (bookingRows ?? []) as unknown as {
      conversation_id: string | null; booking_date: string; number_of_people: number
      service: { name: string }[] | { name: string } | null
    }[]) {
      const contactId = b.conversation_id ? convIdToContact.get(b.conversation_id) : null
      if (!contactId) continue
      const list = bookingsByContact.get(contactId) ?? []
      list.push({
        conversation_id: b.conversation_id,
        booking_date: b.booking_date,
        number_of_people: b.number_of_people,
        service_name: Array.isArray(b.service) ? (b.service[0]?.name ?? null) : (b.service?.name ?? null),
      })
      bookingsByContact.set(contactId, list)
    }
  }

  return { convsByContact, bookingsByContact }
}

/** Most-recent conversation with an open hold wins for Needs You; otherwise
 *  the most-recently-active conversation, for lastInteractionAt/conversationId. */
function primaryConversation(convs: ConvLite[] | undefined): ConvLite | undefined {
  if (!convs || convs.length === 0) return undefined
  const held = convs.find((c) => conversationNeedsFounder(c))
  if (held) return held
  return [...convs].sort((a, b) => Date.parse(b.last_message_at ?? '') - Date.parse(a.last_message_at ?? ''))[0]
}

function bookingSummary(bookings: BookingLite[] | undefined, now: Date) {
  const list = bookings ?? []
  const todayStr = now.toISOString().slice(0, 10)
  const upcoming = list.find((b) => b.booking_date >= todayStr)
  return {
    count: list.length,
    upcoming: upcoming ? { service_name: upcoming.service_name, booking_date: upcoming.booking_date } : null,
  }
}

function customerSummary(
  contact: ContactRow, conv: ConvLite | undefined, bookings: BookingLite[] | undefined, now: Date
): PersonSummary {
  const { needsYou, reason } = needsYouFor(conv)
  const input: CustomerInput = {
    is_blocked: contact.is_blocked, opted_out: contact.opted_out,
    bookings: bookingSummary(bookings, now), needsYou,
  }
  const d = deriveCustomer(input)
  return {
    id: contact.id,
    kind: 'customer',
    name: contact.name || contact.phone_number || contact.email || 'Unknown',
    company: null,
    channel: contact.channel_type,
    email: contact.email,
    phone: contact.phone_number,
    state: d.state,
    stateLabel: d.stateLabel,
    rowContext: d.rowContext,
    nextAction: d.nextAction,
    needsYou,
    needsYouReason: reason,
    lastInteractionAt: contact.last_message_at,
    conversationId: conv?.id ?? null,
  }
}

async function loadCustomerList(supabase: ServiceClient, workspaceId: string): Promise<PersonSummary[]> {
  const [{ data: contacts }, accountIds] = await Promise.all([
    supabase
      .from('contacts')
      .select('id, name, phone_number, email, channel_type, last_message_at, is_blocked, opted_out, ai_contact_profile, ai_contact_facts')
      .eq('customer_id', workspaceId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(LIST_CAP),
    connectedAccountIds(supabase, workspaceId),
  ])

  const rows = (contacts ?? []) as ContactRow[]
  const { convsByContact, bookingsByContact } = await fetchContactContext(supabase, accountIds, rows.map((c) => c.id))
  const now = new Date()

  return rows.map((c) => customerSummary(c, primaryConversation(convsByContact.get(c.id)), bookingsByContact.get(c.id), now))
}

async function loadCustomerDetail(supabase: ServiceClient, workspaceId: string, id: string): Promise<PersonDetail | null> {
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, phone_number, email, channel_type, last_message_at, first_message_at, is_blocked, opted_out, ai_contact_profile, ai_contact_facts')
    .eq('customer_id', workspaceId)
    .eq('id', id)
    .maybeSingle()
  if (!contact) return null

  const accountIds = await connectedAccountIds(supabase, workspaceId)
  const { convsByContact, bookingsByContact } = await fetchContactContext(supabase, accountIds, [id])
  const convs = convsByContact.get(id) ?? []
  const conv = primaryConversation(convs)
  const bookings = (bookingsByContact.get(id) ?? []).slice().sort((a, b) => Date.parse(a.booking_date) - Date.parse(b.booking_date))
  const now = new Date()

  const input: CustomerInput = {
    is_blocked: contact.is_blocked, opted_out: contact.opted_out,
    bookings: bookingSummary(bookings, now), needsYou: needsYouFor(conv).needsYou,
  }
  const summary = customerSummary(contact as ContactRow, conv, bookings, now)

  const history: { at: string; label: string }[] = []
  if (contact.first_message_at) history.push({ at: contact.first_message_at, label: 'First conversation' })
  for (const b of bookings) history.push({ at: b.booking_date, label: `Booking${b.service_name ? ` — ${b.service_name}` : ''}` })
  history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  const facts = contact.ai_contact_facts as PersonFacts | null
  const upcomingCount = bookings.filter((b) => b.booking_date >= now.toISOString().slice(0, 10)).length
  const pastCount = bookings.length - upcomingCount

  return {
    ...summary,
    understanding: describeCustomerUnderstanding(summary.name, input, facts),
    current: deriveCustomer(input).current,
    knownFacts: customerKnownFacts(facts),
    history,
    whyFound: null,
    conversionValue: bookings.length > 0
      ? `${bookings.length} booking${bookings.length === 1 ? '' : 's'}${pastCount > 0 && upcomingCount > 0 ? ` (${upcomingCount} upcoming)` : ''}`
      : null,
  }
}

// ── Route ────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 })

  const supabase = createServiceClient()

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: ws } = await supabase.from('customers').select('workspace_kind').eq('id', workspaceId).maybeSingle()
  const isSales = hasSalesCapability(ws)

  const personId = req.nextUrl.searchParams.get('id')
  if (personId) {
    const person = isSales
      ? await loadProspectDetail(supabase, workspaceId, personId)
      : await loadCustomerDetail(supabase, workspaceId, personId)
    return NextResponse.json({ person })
  }

  const people = isSales
    ? await loadProspectList(supabase, workspaceId)
    : await loadCustomerList(supabase, workspaceId)

  return NextResponse.json({ people, workspaceKind: ws?.workspace_kind ?? null })
}
