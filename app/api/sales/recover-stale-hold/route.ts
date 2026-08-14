import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { applyEscalation } from '@/lib/whatsapp/escalation'
import { sendZohoReply } from '@/lib/email-ai'
import { ensureTagline } from '@/lib/voice-profile'
import type { VoiceProfile } from '@/lib/voice-profile'
import { deliverStaleSalesHoldRecovery } from '@/lib/sales/stale-hold-recovery'

/**
 * Explicit recovery only. It deliberately cannot be called by inbound
 * webhooks/pollers and does not touch inbound provider claims.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return NextResponse.json({ error: 'Missing auth token' }, { status: 401 })
  const supabase = createServiceClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { conversationId?: string; originalMessageId?: string; operatorId?: number }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  if (!body.conversationId || !body.originalMessageId || !Number.isInteger(body.operatorId)) {
    return NextResponse.json({ error: 'conversationId, originalMessageId, and operatorId are required' }, { status: 400 })
  }

  const { data: conversation } = await supabase.from('unified_conversations').select(`
    id, channel_type, customer_id, customer_name, metadata, connected_account:connected_accounts(id, user_id)
  `).eq('id', body.conversationId).maybeSingle()
  const account = conversation && (Array.isArray(conversation.connected_account)
    ? conversation.connected_account[0] : conversation.connected_account)
  if (!conversation || !account) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  const workspaceId = account.user_id
  // This is an explicit owner operation, not a general workspace-member
  // capability. The SQL receipt also requires the named allowlist operator
  // to be an owner/founder in this same workspace.
  if (workspaceId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (conversation.channel_type !== 'email') {
    return NextResponse.json({ error: 'Stale Sales hold recovery currently supports email only' }, { status: 400 })
  }

  const { data: claim, error: claimError } = await supabase.rpc('sales_claim_stale_hold_recovery', {
    p_workspace_id: workspaceId, p_conversation_id: body.conversationId,
    p_original_message_id: body.originalMessageId, p_operator_allowlist_id: body.operatorId,
  }).maybeSingle()
  if (claimError || !claim) return NextResponse.json({ error: claimError?.message ?? 'Recovery cannot be claimed' }, { status: 409 })
  const claimed = claim as { recovery_id: string; status: string }
  if (claimed.status !== 'claimed') {
    return NextResponse.json({ error: 'Recovery was already attempted', recovery_id: claimed.recovery_id, status: claimed.status }, { status: 409 })
  }

  const { data: inbound } = await supabase.from('unified_messages')
    .select('id, content, channel_message_id, sent_at, metadata')
    .eq('id', body.originalMessageId).eq('conversation_id', body.conversationId).maybeSingle()
  if (!inbound) return NextResponse.json({ error: 'Stored inbound disappeared after claim' }, { status: 409 })
  const meta = (inbound.metadata ?? {}) as Record<string, unknown>
  const subject = typeof meta.subject === 'string' ? meta.subject : '(no subject)'
  const threadId = typeof meta.zoho_thread_id === 'string'
    ? meta.zoho_thread_id
    : typeof (conversation.metadata as Record<string, unknown> | null)?.thread_id === 'string'
      ? (conversation.metadata as Record<string, unknown>).thread_id as string : conversation.customer_id
  const [{ data: aiConfig }, { data: customer }] = await Promise.all([
    supabase.from('workspace_ai_config').select('system_prompt').eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('customers').select('ai_voice_profile').eq('id', workspaceId).maybeSingle(),
  ])
  const voiceProfile = (customer?.ai_voice_profile ?? undefined) as VoiceProfile | undefined
  const prompt = aiConfig?.system_prompt || 'You are a helpful assistant. Reply to customer emails warmly and professionally.'
  const recoveryId = claimed.recovery_id

  const result = await deliverStaleSalesHoldRecovery({
    async generate() {
      let decision = await generateCayeAutoReply(prompt, {
        senderName: conversation.customer_name || conversation.customer_id,
        body: inbound.content || subject, channel: 'email', subject, workspaceId,
        conversationId: conversation.id, senderEmail: conversation.customer_id,
        currentChannelMessageId: inbound.channel_message_id || inbound.id, receivedAt: inbound.sent_at,
        staleHoldRecoveryId: recoveryId, staleHoldRecoveryOriginalMessageId: inbound.id,
      }, voiceProfile)
      decision = await applyEscalation(decision, {
        workspaceId, conversationId: conversation.id, contactName: conversation.customer_name || conversation.customer_id,
        body: inbound.content || subject,
      })
      if (decision.action === 'reply') return { action: 'reply', content: ensureTagline(decision.content, voiceProfile) }
      return { action: decision.action === 'hold' ? 'hold' : 'ignore', reason: decision.reason }
    },
    async block(reason) {
      await supabase.rpc('sales_block_stale_hold_recovery', { p_recovery_id: recoveryId, p_workspace_id: workspaceId, p_reason: reason })
    },
    async prepare(replySubject, replyBody, sentAt) {
      const { error } = await supabase.rpc('sales_prepare_stale_hold_recovery_delivery', {
        p_recovery_id: recoveryId, p_workspace_id: workspaceId, p_subject: replySubject,
        p_body: replyBody, p_sent_at: sentAt,
      })
      if (error) throw new Error(error.message)
    },
    async send(replyBody) {
      return sendZohoReply(conversation.customer_id, subject.startsWith('Re:') ? subject : `Re: ${subject}`,
        replyBody,
        threadId, workspaceId)
    },
    async complete(sentAt, providerMessageId) {
      const { data, error } = await supabase.rpc('sales_complete_stale_hold_recovery', {
        p_recovery_id: recoveryId, p_workspace_id: workspaceId, p_sent_at: sentAt,
        p_provider_message_id: providerMessageId,
      })
      if (error || (data !== 'sent' && data !== 'sent_hold_preserved')) throw new Error(error?.message ?? 'Invalid completion')
      return data
    },
    async markUnknown(reason) {
      await supabase.rpc('sales_mark_stale_hold_recovery_unknown', { p_recovery_id: recoveryId, p_workspace_id: workspaceId, p_reason: reason })
    },
  }, subject.startsWith('Re:') ? subject : `Re: ${subject}`)

  return NextResponse.json({ recovery_id: recoveryId, status: result }, { status: result === 'sent' ? 200 : 409 })
}
