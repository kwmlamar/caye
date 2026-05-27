/**
 * GET /api/caye/health
 *
 * Returns operational metrics for the Caye AI receptionist scoped to the
 * caller's workspace. Powers the Caye Health settings panel — the answer
 * to "is Caye actually doing the things she's supposed to be doing?"
 *
 * Auth: standard supabase session cookie. Workspace is resolved from the
 * authenticated user via workspace_members.
 */

import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createServiceClient } from '@/lib/supabase-server'

interface HealthCounts {
  caye_auto_replies_7d: number
  caye_holds_7d: number
  identity_guard_blocks_7d: number
  hold_reasons_top: Array<{ reason: string; count: number }>
}

interface BookingActionCounts {
  created_by_caye_7d: number
  cancelled_by_caye_7d: number
  rescheduled_by_caye_7d: number
  total_active_bookings: number
}

interface LearningHealth {
  voice_profile_updated_at: string | null
  owner_messages_since_profile_update: number
  voice_profile_formality: string | null
  contacts_with_style_profile: number
  total_email_contacts: number
  owner_corrections_7d: number
}

interface ChannelActivity {
  channel: string
  inbound_7d: number
  outbound_7d: number
}

export interface CayeHealthResponse {
  workspace_id: string
  generated_at: string
  caye: HealthCounts
  bookings: BookingActionCounts
  learning: LearningHealth
  channels: ChannelActivity[]
}

export async function GET() {
  // ── Auth via supabase cookie session ───────────────────────────────────────
  const cookieStore = await cookies()
  const authedClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {}, // read-only here
      },
    }
  )

  const {
    data: { user },
    error: authErr,
  } = await authedClient.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Resolve workspace. For now, owners are workspace_id == user.id (matches
  // existing pattern across the app).
  const workspaceId = user.id
  const supabase = createServiceClient()

  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // ── Caye replies + holds (last 7d) ─────────────────────────────────────────
  // Auto-reply = unified_messages with metadata.generated_by='caye' and not
  // internal. Hold = same source, but is_internal=true and has hold_reason.
  const { data: cayeMessages } = await supabase
    .from('unified_messages')
    .select('is_internal, metadata, unified_conversations!inner(connected_accounts!inner(user_id))')
    .eq('unified_conversations.connected_accounts.user_id', workspaceId)
    .gte('sent_at', since7d)
    .filter('metadata->>generated_by', 'eq', 'caye')

  const cayeRows = (cayeMessages ?? []) as Array<{
    is_internal: boolean
    metadata: Record<string, unknown> | null
  }>

  let autoRepliesSent = 0
  let holds = 0
  let identityBlocks = 0
  const holdReasonCounts = new Map<string, number>()

  for (const r of cayeRows) {
    const reason = (r.metadata?.hold_reason as string | undefined) ?? null
    if (r.is_internal && reason) {
      holds++
      if (reason.toLowerCase().startsWith('identity guard')) identityBlocks++
      // Bucket free-form reasons into a coarser category for the top-3 view
      const bucket = reason.toLowerCase().startsWith('identity guard')
        ? 'identity guard'
        : reason.length > 40
          ? reason.slice(0, 40) + '…'
          : reason
      holdReasonCounts.set(bucket, (holdReasonCounts.get(bucket) ?? 0) + 1)
    } else if (!r.is_internal) {
      autoRepliesSent++
    }
  }

  const hold_reasons_top = Array.from(holdReasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }))

  // ── Booking actions (last 7d, marker-based) ────────────────────────────────
  // [Caye create] / [Caye cancel] / [Caye reschedule] markers are appended
  // to bookings.notes by the corresponding tools.
  const [
    { count: created7d },
    { count: cancelled7d },
    { count: rescheduled7d },
    { count: totalActive },
  ] = await Promise.all([
    supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', workspaceId)
      .gte('created_at', since7d)
      .ilike('notes', '%[Caye create]%'),
    supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', workspaceId)
      .gte('cancelled_at', since7d)
      .ilike('notes', '%[Caye cancel]%'),
    supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', workspaceId)
      .gte('updated_at', since7d)
      .ilike('notes', '%[Caye reschedule]%'),
    supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', workspaceId)
      .in('status', ['confirmed', 'pending']),
  ])

  // ── Learning health ────────────────────────────────────────────────────────
  const { data: workspaceRow } = await supabase
    .from('customers')
    .select('voice_profile_updated_at, owner_messages_since_profile_update, ai_voice_profile')
    .eq('id', workspaceId)
    .maybeSingle()

  const voiceProfile = (workspaceRow?.ai_voice_profile ?? null) as Record<string, unknown> | null
  const voice_profile_formality = (voiceProfile?.formality_level as string | undefined) ?? null

  const { count: contactsWithStyle } = await supabase
    .from('contacts')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', workspaceId)
    .not('ai_contact_profile', 'is', null)

  const { count: totalEmailContacts } = await supabase
    .from('contacts')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', workspaceId)
    .eq('channel_type', 'email')

  // Corrections: owner Zoho replies tagged with metadata.is_correction=true
  // by lib/owner-correction.ts in the email/poll route.
  const { data: correctionRows } = await supabase
    .from('unified_messages')
    .select('id, unified_conversations!inner(connected_accounts!inner(user_id))')
    .eq('unified_conversations.connected_accounts.user_id', workspaceId)
    .gte('sent_at', since7d)
    .filter('metadata->>is_correction', 'eq', 'true')

  // ── Channel activity (last 7d, in + out) ───────────────────────────────────
  const { data: channelRows } = await supabase
    .from('unified_messages')
    .select(
      'sender_type, unified_conversations!inner(channel_type, connected_accounts!inner(user_id))'
    )
    .eq('unified_conversations.connected_accounts.user_id', workspaceId)
    .eq('is_internal', false)
    .gte('sent_at', since7d)

  const channelCounts = new Map<string, { inbound: number; outbound: number }>()
  type ChannelRow = {
    sender_type: 'customer' | 'business'
    unified_conversations: { channel_type: string }[] | { channel_type: string }
  }
  for (const r of (channelRows ?? []) as ChannelRow[]) {
    const channel = Array.isArray(r.unified_conversations)
      ? r.unified_conversations[0]?.channel_type
      : r.unified_conversations?.channel_type
    if (!channel) continue
    if (!channelCounts.has(channel)) channelCounts.set(channel, { inbound: 0, outbound: 0 })
    const bucket = channelCounts.get(channel)!
    if (r.sender_type === 'customer') bucket.inbound++
    else bucket.outbound++
  }

  const channels: ChannelActivity[] = Array.from(channelCounts.entries())
    .map(([channel, counts]) => ({
      channel,
      inbound_7d: counts.inbound,
      outbound_7d: counts.outbound,
    }))
    .sort((a, b) => b.inbound_7d + b.outbound_7d - (a.inbound_7d + a.outbound_7d))

  const response: CayeHealthResponse = {
    workspace_id: workspaceId,
    generated_at: new Date().toISOString(),
    caye: {
      caye_auto_replies_7d: autoRepliesSent,
      caye_holds_7d: holds,
      identity_guard_blocks_7d: identityBlocks,
      hold_reasons_top,
    },
    bookings: {
      created_by_caye_7d: created7d ?? 0,
      cancelled_by_caye_7d: cancelled7d ?? 0,
      rescheduled_by_caye_7d: rescheduled7d ?? 0,
      total_active_bookings: totalActive ?? 0,
    },
    learning: {
      voice_profile_updated_at: workspaceRow?.voice_profile_updated_at ?? null,
      owner_messages_since_profile_update:
        workspaceRow?.owner_messages_since_profile_update ?? 0,
      voice_profile_formality,
      contacts_with_style_profile: contactsWithStyle ?? 0,
      total_email_contacts: totalEmailContacts ?? 0,
      owner_corrections_7d: correctionRows?.length ?? 0,
    },
    channels,
  }

  return NextResponse.json(response)
}
