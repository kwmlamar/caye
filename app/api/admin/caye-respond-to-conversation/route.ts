/**
 * POST /api/admin/caye-respond-to-conversation
 *
 * Manual trigger to run Caye's auto-reply against the most recent customer
 * inbound on a specific conversation. Used when:
 *   - A conversation was created before a webhook fix landed and the inbound
 *     never got an AI reply at the time
 *   - An operator wants to ask Caye to take a thread that's been sitting
 *     held / dormant
 *
 * Same code path as the production webhook's reply path — calls
 * generateCayeAutoReply, sends via sendZohoReply (for email channels),
 * persists the outbound message, handles holds + customer acknowledgement +
 * operator pings + calendar sync. The only thing that's different is the
 * trigger (manual instead of inbound webhook).
 *
 * v1 scope: email channel only. Add WhatsApp/Messenger/IG dispatch if/when
 * the use case shows up.
 *
 * Auth: x-cron-secret header matches CRON_SECRET (same pattern as the
 * other admin/cron routes in this app).
 *
 * Body: { conversationId: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { sendZohoReply } from '@/lib/email-ai'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { syncBookingToCalendar } from '@/lib/calendar-sync'
import type { VoiceProfile } from '@/lib/voice-profile'

export async function POST(request: NextRequest) {
  // Two auth modes:
  //   1. x-cron-secret header matches CRON_SECRET — for server-to-server /
  //      one-off scripts.
  //   2. Authorization: Bearer <supabase_session_jwt> — for the dashboard
  //      user (logged in to Caye) to trigger from the browser. We don't
  //      gate on workspace ownership here in v1 — any authenticated user
  //      can replay a conversation. Tighten later if needed.
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization') ?? ''
  const legacy = request.headers.get('x-cron-secret') ?? ''
  const cronOk = !!secret && (auth === `Bearer ${secret}` || legacy === secret)

  let sessionOk = false
  if (!cronOk && auth.startsWith('Bearer ')) {
    const token = auth.slice(7)
    const probeSupabase = createServiceClient()
    const { data: { user }, error } = await probeSupabase.auth.getUser(token)
    if (!error && user) sessionOk = true
  }

  if (!cronOk && !sessionOk) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { conversationId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const conversationId = body.conversationId
  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversationId' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Load conversation + the connected account it belongs to.
  const { data: conv, error: convErr } = await supabase
    .from('unified_conversations')
    .select('id, channel_type, customer_id, customer_name, connected_account_id, metadata, human_agent_enabled')
    .eq('id', conversationId)
    .maybeSingle()

  if (convErr || !conv) {
    return NextResponse.json(
      { error: `Conversation not found: ${convErr?.message ?? 'no row'}` },
      { status: 404 }
    )
  }

  if (conv.channel_type !== 'email') {
    return NextResponse.json(
      { error: `v1 only supports email channels (got ${conv.channel_type})` },
      { status: 400 }
    )
  }

  const { data: account } = await supabase
    .from('connected_accounts')
    .select('id, user_id')
    .eq('id', conv.connected_account_id)
    .maybeSingle()

  if (!account) {
    return NextResponse.json({ error: 'Connected account not found' }, { status: 404 })
  }

  const workspaceId: string = account.user_id

  // Latest customer inbound on this conversation.
  const { data: lastInbound } = await supabase
    .from('unified_messages')
    .select('id, content, channel_message_id, sent_at, metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!lastInbound) {
    return NextResponse.json(
      { error: 'No customer inbound message on this conversation' },
      { status: 400 }
    )
  }

  const inboundMeta = (lastInbound.metadata ?? {}) as Record<string, unknown>
  const subject =
    typeof inboundMeta.subject === 'string'
      ? (inboundMeta.subject as string)
      : '(no subject)'
  const threadId =
    typeof inboundMeta.zoho_thread_id === 'string'
      ? (inboundMeta.zoho_thread_id as string)
      : typeof (conv.metadata as Record<string, unknown> | null)?.thread_id === 'string'
      ? ((conv.metadata as Record<string, unknown>).thread_id as string)
      : conv.customer_id

  const customerEmail = conv.customer_id
  const customerName = conv.customer_name || customerEmail

  // Workspace AI config + voice profile.
  let systemPrompt =
    'You are a helpful assistant. Reply to customer emails warmly and professionally.'
  const [{ data: aiConfig }, { data: customer }] = await Promise.all([
    supabase
      .from('workspace_ai_config')
      .select('system_prompt')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase
      .from('customers')
      .select('ai_voice_profile')
      .eq('id', workspaceId)
      .maybeSingle(),
  ])
  if (aiConfig?.system_prompt) systemPrompt = aiConfig.system_prompt
  const voiceProfile = (customer?.ai_voice_profile ?? undefined) as VoiceProfile | undefined

  // Run Caye against the latest inbound.
  let decision: Awaited<ReturnType<typeof generateCayeAutoReply>>
  try {
    decision = await generateCayeAutoReply(
      systemPrompt,
      {
        senderName: customerName,
        body: lastInbound.content || subject,
        channel: 'email',
        subject,
        workspaceId,
        conversationId: conversationId,
        senderEmail: customerEmail,
        currentChannelMessageId: lastInbound.channel_message_id || lastInbound.id,
      },
      voiceProfile
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Caye reply generation failed: ${msg}` }, { status: 500 })
  }

  // Hold branch
  if (decision.action === 'hold') {
    await supabase
      .from('unified_conversations')
      .update({ human_agent_enabled: true, human_agent_reason: decision.reason })
      .eq('id', conversationId)
    await supabase.from('unified_messages').insert({
      conversation_id: conversationId,
      channel_message_id: null,
      sender_type: 'business',
      content: decision.note,
      message_type: 'text',
      sent_at: new Date().toISOString(),
      status: 'sent',
      is_internal: true,
      metadata: {
        generated_by: 'caye',
        triggered_by: 'admin/caye-respond-to-conversation',
        hold_reason: decision.reason,
        proposed_reply: decision.proposedReply ?? null,
        customer_acknowledgement: decision.customerAcknowledgement ?? null,
      },
    })

    if (decision.customerAcknowledgement) {
      const ackSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`
      try {
        await sendZohoReply(customerEmail, ackSubject, decision.customerAcknowledgement, threadId, workspaceId)
        await supabase.from('unified_messages').insert({
          conversation_id: conversationId,
          channel_message_id: `caye_ack_${Date.now()}`,
          sender_type: 'business',
          content: decision.customerAcknowledgement,
          message_type: 'text',
          sent_at: new Date().toISOString(),
          status: 'sent',
          metadata: {
            subject: ackSubject,
            is_automated: true,
            is_hold_acknowledgement: true,
            generated_by: 'caye',
            triggered_by: 'admin/caye-respond-to-conversation',
          },
        })
      } catch (err) {
        console.error('[admin/caye-respond] Customer ack send failed:', err)
      }
    }

    enqueueHoldPing({
      workspaceId,
      conversationId: conversationId,
      contactName: customerName,
      reason: decision.reason,
      proposedReply: decision.proposedReply,
      inboundBody: lastInbound.content || '',
      urgency: decision.urgency,
    }).catch((err) => console.error('[admin/caye-respond] enqueueHoldPing failed:', err))

    return NextResponse.json({
      action: 'hold',
      reason: decision.reason,
      proposed_reply: decision.proposedReply,
      customer_acknowledgement_sent: !!decision.customerAcknowledgement,
    })
  }

  // Reply branch
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`
  try {
    await sendZohoReply(customerEmail, replySubject, decision.content, threadId, workspaceId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Zoho send failed: ${msg}` }, { status: 500 })
  }

  // Persist the outbound row with a `caye_admin_*` synthetic
  // channel_message_id and full Caye attribution metadata. The email-poll
  // cron's "is this a Caye send I already stored" check now uses a
  // `caye_%` LIKE pattern (poll route, ~line 431) that recognizes this
  // prefix and will back-fill the real Zoho message id when it sweeps
  // the Sent folder a moment later — so the row persists with the
  // correct attribution AND no duplicate is created.
  const replySentAt = new Date().toISOString()
  await supabase.from('unified_messages').insert({
    conversation_id: conversationId,
    channel_message_id: `caye_admin_${Date.now()}`,
    sender_type: 'business',
    sender_attribution: 'caye_autopilot',
    content: decision.content,
    message_type: 'text',
    sent_at: replySentAt,
    status: 'sent',
    metadata: {
      subject: replySubject,
      is_automated: true,
      generated_by: 'caye',
      sent_by: 'caye',
      triggered_by: 'admin/caye-respond-to-conversation',
    },
  })

  await supabase
    .from('unified_conversations')
    .update({
      last_sender_type: 'business',
      last_business_sender_kind: 'caye',
      last_message_at: replySentAt,
      last_message_preview: decision.content.slice(0, 100),
    })
    .eq('id', conversationId)

  if (decision.bookingId) {
    syncBookingToCalendar(workspaceId, decision.bookingId, 'upsert').catch((err) =>
      console.error('[admin/caye-respond] Calendar sync failed:', err)
    )
  }

  return NextResponse.json({
    action: 'reply',
    content: decision.content,
    booking_id: decision.bookingId ?? null,
    needs_owner_followup: decision.needsOwnerFollowup ?? false,
  })
}
