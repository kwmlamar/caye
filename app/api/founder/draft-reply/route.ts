/**
 * POST /api/founder/draft-reply
 *
 * On-demand draft generation for the dashboard's compose box — returns text
 * to review, WITHOUT sending anything or touching any DB row. This is the
 * manual counterpart to the automatic hold-time proposed_reply: instead of
 * every escalation/hold carrying a pre-baked draft whether the owner wants
 * one or not, the owner clicks "Draft with Caye" only when they actually
 * want a starting point.
 *
 * One button, two modes, chosen by what the thread actually needs:
 *   - New unanswered customer message → generateCayeAutoReply (lib/caye-
 *     reply.ts), same reply brain as the live auto-reply path.
 *   - Last message was already ours (nothing new to respond to) →
 *     generateOutreachFollowupDraft (lib/outreach-nudge.ts), the same
 *     generator outreach-nudge-scan's cron uses for stale-lead nudges — only
 *     wired up for workspace_kind='internal_sales' so far, since that's the
 *     only workspace this has been needed/tested against. Other workspace
 *     kinds still get the "nothing to draft" error in that case rather than
 *     a follow-up nobody asked for.
 *
 * Deliberately skips applyEscalation (lib/whatsapp/escalation.ts) — that
 * writes a caye_escalations row as a side effect, which doesn't belong in a
 * "just show me a draft" endpoint with no corresponding hold/escalation
 * being created. Skips sendZohoReply entirely, unlike
 * /api/admin/caye-respond-to-conversation which replays Caye's full
 * autonomous decision (including live-sending on the 'reply' branch) — that
 * endpoint is for replaying missed auto-replies, not for a review-first
 * draft button.
 *
 * Auth: Bearer session token, workspace_members-checked (same pattern as
 * /api/messages/send).
 *
 * Body: { conversationId: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { generateOutreachFollowupDraft } from '@/lib/outreach-nudge'
import type { VoiceProfile } from '@/lib/voice-profile'
import { ensureTagline } from '@/lib/voice-profile'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) {
    return NextResponse.json({ error: 'Missing auth token' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { conversationId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const conversationId = body.conversationId
  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
  }

  const { data: conv, error: convErr } = await supabase
    .from('unified_conversations')
    .select(`
      id, channel_type, customer_id, customer_name, metadata,
      connected_account:connected_accounts(id, user_id)
    `)
    .eq('id', conversationId)
    .single()

  if (convErr || !conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const account = Array.isArray(conv.connected_account) ? conv.connected_account[0] : conv.connected_account
  if (!account) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Same ownership check as /api/messages/send: the connected_account's
  // user_id IS the workspace id; access requires being that owner or an
  // active workspace_members row.
  if (account.user_id !== user.id) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', account.user_id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  if (conv.channel_type !== 'email') {
    return NextResponse.json(
      { error: `Draft generation currently only supports email conversations (got ${conv.channel_type})` },
      { status: 400 }
    )
  }

  const workspaceId: string = account.user_id
  const customerEmail = conv.customer_id
  const customerName = conv.customer_name || customerEmail

  // Check the single most recent message on the thread, not just the most
  // recent customer message — those aren't the same thing once someone's
  // already replied. Drafting against an old customer message that's
  // already been answered produces a reply with nothing left to say (the
  // model correctly has nothing useful to add, but the real problem is
  // this endpoint shouldn't have tried in the first place).
  const { data: latestMessage } = await supabase
    .from('unified_messages')
    .select('id, sender_type, content, channel_message_id, metadata')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latestMessage) {
    return NextResponse.json({ error: 'No messages on this conversation yet' }, { status: 400 })
  }

  let systemPrompt = 'You are a helpful assistant. Reply to customer emails warmly and professionally.'
  const [{ data: aiConfig }, { data: customer }] = await Promise.all([
    supabase.from('workspace_ai_config').select('system_prompt').eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('customers').select('ai_voice_profile, workspace_kind').eq('id', workspaceId).maybeSingle(),
  ])
  if (aiConfig?.system_prompt) systemPrompt = aiConfig.system_prompt
  const voiceProfile = (customer?.ai_voice_profile ?? undefined) as VoiceProfile | undefined

  // Nothing new since our last message — draft a follow-up instead of a
  // reply, but only where that's an established, tested need.
  if (latestMessage.sender_type !== 'customer') {
    if (customer?.workspace_kind !== 'internal_sales') {
      return NextResponse.json(
        { error: `No new message from ${customerName} since the last reply — nothing to draft yet.` },
        { status: 422 }
      )
    }

    const { data: lead } = await supabase
      .from('outreach_leads')
      .select('business_name')
      .eq('workspace_id', workspaceId)
      .eq('lead_email', customerEmail)
      .maybeSingle()

    const followup = await generateOutreachFollowupDraft({
      systemPrompt,
      leadName: customerName,
      businessName: lead?.business_name || customerName,
    })

    if (!followup.ok) {
      return NextResponse.json(
        { error: `Couldn't draft a follow-up (${followup.reason}) — write this one by hand.` },
        { status: 422 }
      )
    }

    return NextResponse.json({ draft: followup.content, source: 'followup' })
  }

  const lastInbound = latestMessage
  const inboundMeta = (lastInbound.metadata ?? {}) as Record<string, unknown>
  const subject = typeof inboundMeta.subject === 'string' ? inboundMeta.subject : '(no subject)'

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
        conversationId,
        senderEmail: customerEmail,
        currentChannelMessageId: lastInbound.channel_message_id || lastInbound.id,
      },
      voiceProfile
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Draft generation failed: ${msg}` }, { status: 500 })
  }

  // Pick whichever field is actually customer-facing text for this action —
  // never decision.internalContext/reason/note, those are operator-only.
  let draft: string | null = null
  if (decision.action === 'reply') {
    draft = ensureTagline(decision.content, voiceProfile)
  } else if (decision.action === 'hold') {
    draft = decision.proposedReply?.trim() || null
  } else if (decision.action === 'escalate') {
    draft = decision.content
  }

  if (!draft) {
    return NextResponse.json(
      { error: "Caye couldn't draft anything useful for this one — it may need a fully custom reply." },
      { status: 422 }
    )
  }

  return NextResponse.json({ draft, source: decision.action })
}
