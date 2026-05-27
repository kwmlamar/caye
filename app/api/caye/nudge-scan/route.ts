/**
 * GET /api/caye/nudge-scan
 *
 * Daily cron — scans every active workspace with proactive_nudges_enabled
 * and dispatches eligible proactive nudges:
 *   1. Auto-complete sweep: flip confirmed/pending bookings whose end
 *      time has passed by 6h+ to 'completed' so the review-request gate
 *      becomes eligible.
 *   2. Review request pass: completed bookings 24h+ past end-of-day,
 *      no review_requested_at yet → send + stamp.
 *   3. Ghosted lead pass: conversations where Caye replied last 3+ days
 *      ago, no customer follow-up, no booking, no prior nudge → send +
 *      stamp.
 *
 * Secure via CRON_SECRET (same pattern as /api/email/poll).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { sendZohoReply } from '@/lib/email-ai'
import { generateCayeNudge, defaultNudgeSubject, type NudgeKind } from '@/lib/caye-nudge'
import type { VoiceProfile } from '@/lib/voice-profile'
import type { ContactStyleProfile } from '@/types/database'
import {
  shouldAutoCompleteBooking,
  shouldSendReviewRequest,
  shouldSendGhostedLeadNudge,
} from '@/lib/nudge-eligibility'

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant for a service business. Write warmly and ' +
  'professionally on the owner\'s behalf.'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const provided = request.headers.get('x-cron-secret')
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const supabase = createServiceClient()
  const now = new Date()

  // Active workspaces with nudges enabled
  const { data: workspaces } = await supabase
    .from('customers')
    .select('id, business_name, proactive_nudges_enabled')
    .eq('proactive_nudges_enabled', true)

  const summary = {
    workspaces_scanned: 0,
    auto_completed: 0,
    review_requests_sent: 0,
    ghosted_nudges_sent: 0,
    errors: [] as string[],
  }

  for (const workspace of workspaces ?? []) {
    summary.workspaces_scanned++
    try {
      const wsCounts = await processWorkspace(workspace.id, workspace.business_name, now)
      summary.auto_completed += wsCounts.auto_completed
      summary.review_requests_sent += wsCounts.review_requests_sent
      summary.ghosted_nudges_sent += wsCounts.ghosted_nudges_sent
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`workspace ${workspace.id}: ${msg}`)
      console.error(`[nudge-scan] workspace ${workspace.id} failed:`, err)
    }
  }

  console.log('[nudge-scan] complete', summary)
  return NextResponse.json(summary)
}

interface WorkspaceCounts {
  auto_completed: number
  review_requests_sent: number
  ghosted_nudges_sent: number
}

async function processWorkspace(
  workspaceId: string,
  businessName: string,
  now: Date
): Promise<WorkspaceCounts> {
  const supabase = createServiceClient()
  const counts: WorkspaceCounts = {
    auto_completed: 0,
    review_requests_sent: 0,
    ghosted_nudges_sent: 0,
  }

  // ── Workspace AI config + voice profile (one shared load for all nudges) ──
  const [{ data: aiConfig }, { data: customer }] = await Promise.all([
    supabase
      .from('workspace_ai_config')
      .select('system_prompt, ai_enabled')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase
      .from('customers')
      .select('ai_voice_profile, booking_url, website_url, business_name')
      .eq('id', workspaceId)
      .maybeSingle(),
  ])

  // Don't nudge from a workspace where the owner has explicitly turned AI off
  if (aiConfig?.ai_enabled === false) return counts

  const systemPrompt = aiConfig?.system_prompt ?? DEFAULT_SYSTEM_PROMPT
  const voiceProfile = (customer?.ai_voice_profile ?? undefined) as VoiceProfile | undefined

  // ── 1. Auto-complete pass ────────────────────────────────────────────────
  // Bounded lookback so we don't scan the entire history every run.
  const lookbackDate = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10)

  const { data: completionCandidates } = await supabase
    .from('bookings')
    .select('id, status, booking_date, booking_time, duration_minutes')
    .eq('user_id', workspaceId)
    .in('status', ['confirmed', 'pending'])
    .gte('booking_date', lookbackDate)
    .lte('booking_date', now.toISOString().slice(0, 10))

  for (const b of completionCandidates ?? []) {
    if (
      shouldAutoCompleteBooking(
        {
          status: b.status,
          booking_date: b.booking_date,
          booking_time: String(b.booking_time).slice(0, 5),
          duration_minutes: b.duration_minutes,
        },
        now
      )
    ) {
      const { error } = await supabase
        .from('bookings')
        .update({ status: 'completed' })
        .eq('id', b.id)
      if (!error) counts.auto_completed++
    }
  }

  // ── 2. Review request pass ───────────────────────────────────────────────
  const { data: reviewCandidates } = await supabase
    .from('bookings')
    .select(
      'id, customer_name, customer_email, booking_date, status, review_requested_at, ' +
        'conversation_id, service:booking_services(name)'
    )
    .eq('user_id', workspaceId)
    .eq('status', 'completed')
    .is('review_requested_at', null)
    .not('customer_email', 'is', null)
    .gte('booking_date', lookbackDate)

  for (const raw of reviewCandidates ?? []) {
    const b = raw as unknown as {
      id: string
      customer_name: string
      customer_email: string
      booking_date: string
      status: string
      review_requested_at: string | null
      conversation_id: string | null
      service: { name: string }[] | null
    }

    if (!shouldSendReviewRequest(
      { booking_date: b.booking_date, status: b.status, review_requested_at: b.review_requested_at },
      now
    )) continue

    const sent = await sendNudge({
      workspaceId,
      businessName,
      customerName: b.customer_name,
      customerEmail: b.customer_email,
      kind: 'review_request',
      systemPrompt,
      voiceProfile,
      bookingUrl: customer?.booking_url ?? null,
      websiteUrl: customer?.website_url ?? null,
      contactProfile: await loadContactProfile(b.customer_email, workspaceId),
      reviewContext: {
        service_name: b.service?.[0]?.name ?? null,
        booking_date: b.booking_date,
      },
      conversationId: b.conversation_id,
    })

    if (sent) {
      await supabase
        .from('bookings')
        .update({ review_requested_at: now.toISOString() })
        .eq('id', b.id)
      counts.review_requests_sent++
    }
  }

  // ── 3. Ghosted lead pass ─────────────────────────────────────────────────
  // Pull conversations on this workspace's email channels with Caye as the
  // last business sender, customer hasn't replied, no nudge yet, not held.
  const { data: ghostedCandidates } = await supabase
    .from('unified_conversations')
    .select(
      'id, customer_id, customer_name, channel_conversation_id, ' +
        'last_message_at, last_sender_type, last_business_sender_kind, ' +
        'nudge_sent_at, human_agent_enabled, ' +
        'connected_account:connected_accounts!inner(user_id, channel_type)'
    )
    .eq('connected_account.user_id', workspaceId)
    .eq('connected_account.channel_type', 'email')
    .eq('last_sender_type', 'business')
    .eq('last_business_sender_kind', 'caye')
    .is('nudge_sent_at', null)
    .eq('human_agent_enabled', false)
    .lte('last_message_at', new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString())

  for (const raw of ghostedCandidates ?? []) {
    const c = raw as unknown as {
      id: string
      customer_id: string
      customer_name: string | null
      channel_conversation_id: string
      last_message_at: string | null
      last_sender_type: 'customer' | 'business' | null
      last_business_sender_kind: 'caye' | 'human' | null
      nudge_sent_at: string | null
      human_agent_enabled: boolean
    }

    // Count bookings linked to this conversation
    const { count: bookingCount } = await supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', c.id)

    if (!shouldSendGhostedLeadNudge(
      {
        last_message_at: c.last_message_at,
        last_business_sender_kind: c.last_business_sender_kind,
        last_sender_type: c.last_sender_type,
        nudge_sent_at: c.nudge_sent_at,
        booking_count: bookingCount ?? 0,
        human_agent_enabled: c.human_agent_enabled,
      },
      now
    )) continue

    // Build a short excerpt of the recent thread for ghosted_lead context
    const { data: recentMessages } = await supabase
      .from('unified_messages')
      .select('sender_type, content, sent_at')
      .eq('conversation_id', c.id)
      .eq('is_internal', false)
      .order('sent_at', { ascending: false })
      .limit(5)

    const excerpt = (recentMessages ?? [])
      .reverse()
      .map(m => {
        const who = m.sender_type === 'customer' ? 'Them' : 'You'
        return `${who}: ${(m.content ?? '').trim().slice(0, 240)}`
      })
      .join('\n\n')

    // c.customer_id is the bare email for email conversations (per webhook
    // pattern in app/api/webhooks/zoho-email/route.ts).
    const customerEmail = c.customer_id

    const sent = await sendNudge({
      workspaceId,
      businessName,
      customerName: c.customer_name ?? customerEmail,
      customerEmail,
      kind: 'ghosted_lead',
      systemPrompt,
      voiceProfile,
      bookingUrl: customer?.booking_url ?? null,
      websiteUrl: customer?.website_url ?? null,
      contactProfile: await loadContactProfile(customerEmail, workspaceId),
      ghostedContext: { historyExcerpt: excerpt || '(no prior message excerpt)' },
      conversationId: c.id,
      channelConversationId: c.channel_conversation_id,
    })

    if (sent) {
      await supabase
        .from('unified_conversations')
        .update({ nudge_sent_at: now.toISOString() })
        .eq('id', c.id)
      counts.ghosted_nudges_sent++
    }
  }

  return counts
}

async function loadContactProfile(
  email: string,
  workspaceId: string
): Promise<ContactStyleProfile | undefined> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('contacts')
    .select('ai_contact_profile')
    .eq('customer_id', workspaceId)
    .ilike('email', email)
    .maybeSingle()
  return (data?.ai_contact_profile as ContactStyleProfile | null) ?? undefined
}

interface SendNudgeArgs {
  workspaceId: string
  businessName: string
  customerName: string
  customerEmail: string
  kind: NudgeKind
  systemPrompt: string
  voiceProfile?: VoiceProfile
  contactProfile?: ContactStyleProfile
  bookingUrl?: string | null
  websiteUrl?: string | null
  reviewContext?: { service_name: string | null; booking_date: string }
  ghostedContext?: { historyExcerpt: string }
  conversationId: string | null
  channelConversationId?: string
}

/**
 * Generate + send a single nudge. Returns true on success, false on
 * any failure (logged but not surfaced — the cron sweep continues).
 * Also persists the outbound message into unified_messages so the
 * inbox shows it like any other outbound Caye message.
 */
async function sendNudge(args: SendNudgeArgs): Promise<boolean> {
  const generated = await generateCayeNudge({
    systemPrompt: args.systemPrompt,
    voiceProfile: args.voiceProfile,
    contactProfile: args.contactProfile,
    bookingUrl: args.bookingUrl,
    websiteUrl: args.websiteUrl,
    customerName: args.customerName,
    businessName: args.businessName,
    kind: args.kind,
    reviewContext: args.reviewContext,
    ghostedContext: args.ghostedContext,
  })

  if (!generated.ok) {
    console.warn(`[nudge-scan] generation failed (${generated.reason}) for ${args.customerEmail}`)
    return false
  }

  const subject = defaultNudgeSubject(args.kind, args.reviewContext)
  const threadId = args.channelConversationId ?? `caye_nudge_${Date.now()}`

  try {
    await sendZohoReply(args.customerEmail, subject, generated.content, threadId, args.workspaceId)
  } catch (err) {
    console.error(`[nudge-scan] Zoho send failed for ${args.customerEmail}:`, err)
    return false
  }

  // Persist as an outbound business message so the inbox renders it.
  if (args.conversationId) {
    const supabase = createServiceClient()
    const nowISO = new Date().toISOString()
    await supabase.from('unified_messages').insert({
      conversation_id: args.conversationId,
      channel_message_id: `caye_nudge_${Date.now()}`,
      sender_type: 'business',
      content: generated.content,
      message_type: 'text',
      sent_at: nowISO,
      status: 'sent',
      metadata: {
        subject,
        is_automated: true,
        generated_by: 'caye',
        nudge_kind: args.kind,
      },
    })
    await supabase
      .from('unified_conversations')
      .update({
        last_sender_type: 'business',
        last_business_sender_kind: 'caye',
        last_message_at: nowISO,
        last_message_preview: generated.content.slice(0, 100),
      })
      .eq('id', args.conversationId)
  }

  console.log(`[nudge-scan] sent ${args.kind} to ${args.customerEmail} (workspace ${args.workspaceId})`)
  return true
}
