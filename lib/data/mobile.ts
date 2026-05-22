/**
 * Data layer for the mobile PWA screens.
 *
 * Every function takes an explicit workspaceId and queries real Supabase
 * tables. Nothing here uses mock data. Where the design asked for data
 * that has no table yet, the approach is documented inline.
 */

import { getSupabase } from '@/lib/supabase'

// ── Channel mapping ──────────────────────────────────────────────────────────
// DB stores 'whatsapp' | 'instagram' | 'messenger' | 'email' | 'sms'.
// The mobile design uses short codes 'wa' | 'ig' | 'fb' | 'em'.
export type ChCode = 'wa' | 'ig' | 'fb' | 'em'

export function channelCode(dbChannel: string | null | undefined): ChCode {
  switch (dbChannel) {
    case 'whatsapp': return 'wa'
    case 'instagram': return 'ig'
    case 'messenger': return 'fb'
    default: return 'em'
  }
}

export function channelName(ch: ChCode): string {
  return { wa: 'WhatsApp', ig: 'Instagram', fb: 'Messenger', em: 'Email' }[ch]
}

// ── Date helpers (operator-local, never UTC) ─────────────────────────────────
export function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function todayISO(): string {
  return localISO(new Date())
}

export interface WeekDay {
  iso: string
  dow: string
  num: number
  isToday: boolean
}

/** The real current Sun–Sat week — used by the Bookings date strip. */
export function weekAround(anchor: Date): WeekDay[] {
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const start = new Date(anchor)
  start.setDate(anchor.getDate() - anchor.getDay())
  const today = todayISO()
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const iso = localISO(d)
    return { iso, dow: DOW[d.getDay()], num: d.getDate(), isToday: iso === today }
  })
}

function fmtClock(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  let h = d.getHours()
  const m = d.getMinutes()
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${String(m).padStart(2, '0')} ${ap}`
}

function relTime(iso: string | null): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function isCayeAuthored(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!metadata) return false
  return metadata.generated_by === 'caye' || metadata.is_automated === true
}

// ── Internal: workspace conversations ────────────────────────────────────────
interface ConvRow {
  id: string
  customer_name: string | null
  channel_type: string
  human_agent_enabled: boolean
  human_agent_reason: string | null
  human_agent_marked_at: string | null
  last_message_at: string | null
  last_message_preview: string | null
  last_sender_type: string | null
}

async function workspaceConversations(workspaceId: string): Promise<ConvRow[]> {
  const supabase = getSupabase()
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
  if (accountIds.length === 0) return []

  const { data } = await supabase
    .from('unified_conversations')
    .select('id, customer_name, channel_type, human_agent_enabled, human_agent_reason, human_agent_marked_at, last_message_at, last_message_preview, last_sender_type')
    .in('connected_account_id', accountIds)
    .eq('is_archived', false)
    .order('last_message_at', { ascending: false, nullsFirst: false })

  return (data as ConvRow[]) ?? []
}

// ── HOME ─────────────────────────────────────────────────────────────────────
export interface HandledItem {
  id: string
  who: string
  channel: ChCode
  type: 'booked' | 'replied'
  summary: string
  time: string
}

export interface HeldPreview {
  id: string
  who: string
  channel: ChCode
  reason: string
  time: string
}

export interface HomeSummary {
  handled: number
  held: number
  booked: number
  heldPreview: HeldPreview | null
  handledToday: HandledItem[]
}

export async function getMobileHome(workspaceId: string): Promise<HomeSummary> {
  const supabase = getSupabase()
  const convs = await workspaceConversations(workspaceId)

  const heldConvs = convs.filter(c => c.human_agent_enabled)

  // Bookings created/scheduled for today
  const { data: bks } = await supabase
    .from('bookings')
    .select('id')
    .eq('user_id', workspaceId)
    .eq('booking_date', todayISO())
    .neq('status', 'cancelled')
  const booked = (bks ?? []).length

  let handled = 0
  let handledToday: HandledItem[] = []

  if (convs.length > 0) {
    const convMap = new Map(convs.map(c => [c.id, c]))
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)

    const { data: msgs } = await supabase
      .from('unified_messages')
      .select('id, conversation_id, content, sent_at, metadata, is_internal, sender_type')
      .in('conversation_id', convs.map(c => c.id))
      .eq('sender_type', 'business')
      .gte('sent_at', startOfToday.toISOString())
      .order('sent_at', { ascending: false })

    const cayeMsgs = (msgs ?? []).filter(
      (m: { is_internal: boolean; metadata: Record<string, unknown> }) =>
        !m.is_internal && isCayeAuthored(m.metadata)
    )
    handled = cayeMsgs.length
    handledToday = cayeMsgs.slice(0, 4).map((m: {
      id: string; conversation_id: string; content: string | null; sent_at: string
    }) => {
      const c = convMap.get(m.conversation_id)
      return {
        id: m.id,
        who: c?.customer_name || 'Guest',
        channel: channelCode(c?.channel_type),
        type: 'replied' as const,
        summary: m.content?.slice(0, 80) || '',
        time: fmtClock(m.sent_at),
      }
    })
  }

  const first = heldConvs[0]
  const heldPreview: HeldPreview | null = first
    ? {
        id: first.id,
        who: first.customer_name || 'Guest',
        channel: channelCode(first.channel_type),
        reason: first.human_agent_reason || 'Caye paused this conversation for your review.',
        time: relTime(first.human_agent_marked_at || first.last_message_at),
      }
    : null

  return { handled, held: heldConvs.length, booked, heldPreview, handledToday }
}

// ── BOOKINGS ─────────────────────────────────────────────────────────────────
export interface MobileBooking {
  id: string
  time: string
  ampm: string
  durLabel: string
  tour: string
  guest: string
  people: number
  channel: ChCode
  byCaye: boolean
  status: string
  phone: string | null
  email: string | null
  notes: string | null
  dateLabel: string
}

interface BookingRow {
  id: string
  customer_name: string
  customer_phone: string | null
  customer_email: string | null
  booking_date: string
  booking_time: string
  number_of_people: number
  status: string
  notes: string | null
  conversation_id: string | null
  service: { name: string; duration_minutes: number }[] | null
}

function durLabel(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

function splitTime(timeStr: string): { time: string; ampm: string } {
  const [hRaw, mRaw] = timeStr.split(':')
  let h = Number(hRaw)
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return { time: `${h}:${mRaw ?? '00'}`, ampm }
}

async function bookingsBetween(workspaceId: string, startISO: string, endISO: string): Promise<BookingRow[]> {
  const supabase = getSupabase()
  const { data } = await supabase
    .from('bookings')
    .select('id, customer_name, customer_phone, customer_email, booking_date, booking_time, number_of_people, status, notes, conversation_id, service:booking_services(name, duration_minutes)')
    .eq('user_id', workspaceId)
    .gte('booking_date', startISO)
    .lte('booking_date', endISO)
    .neq('status', 'cancelled')
    .order('booking_date')
    .order('booking_time')
  return ((data as unknown) as BookingRow[]) ?? []
}

/** Bookings for a single day, shaped for the mobile cards. */
export async function getBookings(workspaceId: string, isoDate: string): Promise<MobileBooking[]> {
  const rows = await bookingsBetween(workspaceId, isoDate, isoDate)

  // Resolve channel per booking from its source conversation, batched.
  const convIds = rows.map(r => r.conversation_id).filter((v): v is string => !!v)
  const chanByConv = new Map<string, string>()
  if (convIds.length > 0) {
    const supabase = getSupabase()
    const { data: convs } = await supabase
      .from('unified_conversations')
      .select('id, channel_type')
      .in('id', convIds)
    for (const c of (convs ?? []) as { id: string; channel_type: string }[]) {
      chanByConv.set(c.id, c.channel_type)
    }
  }

  const dateLabel = new Date(isoDate + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })

  return rows.map(r => {
    const { time, ampm } = splitTime(r.booking_time)
    const svc = r.service?.[0]
    return {
      id: r.id,
      time,
      ampm,
      durLabel: durLabel(svc?.duration_minutes ?? 120),
      tour: svc?.name ?? 'Island tour',
      guest: r.customer_name,
      people: r.number_of_people,
      channel: channelCode(r.conversation_id ? chanByConv.get(r.conversation_id) : undefined),
      byCaye: !!r.conversation_id,
      status: r.status,
      phone: r.customer_phone,
      email: r.customer_email,
      notes: r.notes,
      dateLabel,
    }
  })
}

/** Per-day booking counts for the week strip. */
export async function getWeekCounts(
  workspaceId: string,
  week: WeekDay[]
): Promise<Record<string, { count: number; caye: number }>> {
  const rows = await bookingsBetween(workspaceId, week[0].iso, week[week.length - 1].iso)
  const out: Record<string, { count: number; caye: number }> = {}
  for (const d of week) out[d.iso] = { count: 0, caye: 0 }
  for (const r of rows) {
    if (!out[r.booking_date]) continue
    out[r.booking_date].count++
    if (r.conversation_id) out[r.booking_date].caye++
  }
  return out
}

// ── HELD ─────────────────────────────────────────────────────────────────────
export interface HeldThreadMsg {
  who: 'guest' | 'caye' | 'business'
  text: string
}

export interface HeldDetail {
  id: string
  who: string
  channel: ChCode
  channelName: string
  reason: string
  cayeNote: string | null
  time: string
  transcript: HeldThreadMsg[]
}

interface MsgRow {
  id: string
  content: string | null
  sender_type: string
  is_internal: boolean
  sent_at: string
  metadata: Record<string, unknown>
}

export async function getHeldConversations(workspaceId: string): Promise<HeldDetail[]> {
  const supabase = getSupabase()
  const convs = await workspaceConversations(workspaceId)
  const held = convs.filter(c => c.human_agent_enabled)
  if (held.length === 0) return []

  const { data: allMsgs } = await supabase
    .from('unified_messages')
    .select('id, conversation_id, content, sender_type, is_internal, sent_at, metadata')
    .in('conversation_id', held.map(c => c.id))
    .order('sent_at', { ascending: true })

  const byConv = new Map<string, MsgRow[]>()
  for (const m of (allMsgs ?? []) as (MsgRow & { conversation_id: string })[]) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, [])
    byConv.get(m.conversation_id)!.push(m)
  }

  return held.map(c => {
    const msgs = byConv.get(c.id) ?? []
    const visible = msgs.filter(m => !m.is_internal).slice(-6)
    const transcript: HeldThreadMsg[] = visible.map(m => ({
      who:
        m.sender_type === 'customer'
          ? 'guest'
          : isCayeAuthored(m.metadata)
            ? 'caye'
            : 'business',
      text: m.content ?? '',
    }))
    // Caye's hold note — the owner-brief written when she paused the thread.
    const cayeNote =
      [...msgs].reverse().find(m => m.is_internal && isCayeAuthored(m.metadata))?.content ?? null
    const ch = channelCode(c.channel_type)
    return {
      id: c.id,
      who: c.customer_name || 'Guest',
      channel: ch,
      channelName: channelName(ch),
      reason: c.human_agent_reason || 'Caye paused this conversation for your review.',
      cayeNote,
      time: relTime(c.human_agent_marked_at || c.last_message_at),
      transcript,
    }
  })
}

/**
 * Records an operator reply on a held conversation and resumes Caye.
 *
 * Note: this writes the message to unified_messages and clears the hold.
 * Actual delivery to the customer's channel goes through the channel send
 * pipeline, which is not yet wired (no /api/messages/send route exists).
 */
export async function resolveHeld(
  conversationId: string,
  replyText: string
): Promise<{ error: string | null }> {
  const supabase = getSupabase()
  const now = new Date().toISOString()

  if (replyText.trim()) {
    const { error: msgErr } = await supabase.from('unified_messages').insert({
      conversation_id: conversationId,
      channel_message_id: null,
      sender_type: 'business',
      content: replyText.trim(),
      message_type: 'text',
      sent_at: now,
      status: 'sent',
      is_internal: false,
      metadata: { sent_from: 'mobile' },
    })
    if (msgErr) return { error: msgErr.message }
  }

  const { error: convErr } = await supabase
    .from('unified_conversations')
    .update({
      human_agent_enabled: false,
      human_agent_reason: null,
      human_agent_marked_at: null,
      last_sender_type: replyText.trim() ? 'business' : undefined,
      last_message_at: replyText.trim() ? now : undefined,
      last_message_preview: replyText.trim() ? replyText.trim().slice(0, 100) : undefined,
    })
    .eq('id', conversationId)

  return { error: convErr?.message ?? null }
}

// ── ACTIVITY FEED (derived — there is no activity table) ─────────────────────
export interface ActivityItem {
  id: string
  type: 'booked' | 'replied' | 'flagged'
  who: string
  what: string
  detail: string
  channel: ChCode
  time: string
  ts: number
}

export async function getActivityFeed(
  workspaceId: string
): Promise<{ today: ActivityItem[]; yesterday: ActivityItem[] }> {
  const supabase = getSupabase()
  const convs = await workspaceConversations(workspaceId)
  const convMap = new Map(convs.map(c => [c.id, c]))

  const twoDaysAgo = new Date()
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 1)
  twoDaysAgo.setHours(0, 0, 0, 0)

  const items: ActivityItem[] = []

  // Caye messages: replies (visible) + holds (internal notes → flagged)
  if (convs.length > 0) {
    const { data: msgs } = await supabase
      .from('unified_messages')
      .select('id, conversation_id, content, sent_at, metadata, is_internal, sender_type')
      .in('conversation_id', convs.map(c => c.id))
      .eq('sender_type', 'business')
      .gte('sent_at', twoDaysAgo.toISOString())
      .order('sent_at', { ascending: false })

    for (const m of (msgs ?? []) as (MsgRow & { conversation_id: string })[]) {
      if (!isCayeAuthored(m.metadata)) continue
      const c = convMap.get(m.conversation_id)
      const ch = channelCode(c?.channel_type)
      items.push({
        id: m.id,
        type: m.is_internal ? 'flagged' : 'replied',
        who: c?.customer_name || 'Guest',
        what: m.is_internal ? 'Held for your review' : 'Replied to a customer message',
        detail: (m.content ?? '').slice(0, 90),
        channel: ch,
        time: fmtClock(m.sent_at),
        ts: new Date(m.sent_at).getTime(),
      })
    }
  }

  // Caye bookings
  const { data: bks } = await supabase
    .from('bookings')
    .select('id, customer_name, number_of_people, booking_date, booking_time, conversation_id, created_at, service:booking_services(name)')
    .eq('user_id', workspaceId)
    .gte('created_at', twoDaysAgo.toISOString())
    .order('created_at', { ascending: false })

  for (const b of (bks ?? []) as unknown as {
    id: string; customer_name: string; number_of_people: number
    booking_date: string; booking_time: string; conversation_id: string | null
    created_at: string; service: { name: string }[] | null
  }[]) {
    if (!b.conversation_id) continue // only Caye-sourced bookings
    const c = convMap.get(b.conversation_id)
    items.push({
      id: b.id,
      type: 'booked',
      who: b.customer_name,
      what: b.service?.[0]?.name ?? 'a tour',
      detail: `${b.number_of_people} guest${b.number_of_people === 1 ? '' : 's'} · ${b.booking_date}`,
      channel: channelCode(c?.channel_type),
      time: fmtClock(b.created_at),
      ts: new Date(b.created_at).getTime(),
    })
  }

  items.sort((a, b) => b.ts - a.ts)

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const todayTs = startOfToday.getTime()

  return {
    today: items.filter(i => i.ts >= todayTs),
    yesterday: items.filter(i => i.ts < todayTs),
  }
}

// ── STANDING RULES ───────────────────────────────────────────────────────────
export interface StandingRule {
  id: string
  rule_text: string
  is_active: boolean
  times_used: number
  created_at: string
}

export async function getStandingRules(workspaceId: string): Promise<StandingRule[]> {
  const supabase = getSupabase()
  const { data } = await supabase
    .from('standing_rules')
    .select('id, rule_text, is_active, times_used, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
  return (data as StandingRule[]) ?? []
}

export async function addStandingRule(
  workspaceId: string,
  ruleText: string
): Promise<{ error: string | null }> {
  const supabase = getSupabase()
  const { error } = await supabase
    .from('standing_rules')
    .insert({ workspace_id: workspaceId, rule_text: ruleText.trim() })
  return { error: error?.message ?? null }
}

export async function updateStandingRule(
  id: string,
  ruleText: string
): Promise<{ error: string | null }> {
  const supabase = getSupabase()
  const { error } = await supabase
    .from('standing_rules')
    .update({ rule_text: ruleText.trim(), updated_at: new Date().toISOString() })
    .eq('id', id)
  return { error: error?.message ?? null }
}

export async function deleteStandingRule(id: string): Promise<{ error: string | null }> {
  const supabase = getSupabase()
  const { error } = await supabase.from('standing_rules').delete().eq('id', id)
  return { error: error?.message ?? null }
}
