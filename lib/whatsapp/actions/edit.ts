import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { resolveItemRef, type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'
import type { VoiceProfile } from '@/lib/voice-profile'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'

/**
 * Compose a revised draft per the operator's instruction and stage it —
 * NEVER send directly from here.
 *
 * Before 2026-08-07 this dispatched the revised reply straight to the
 * customer in the same call, with no confirmation step at all — the only
 * send-capable action in this module that didn't require an existing
 * reviewed proposedReply first (contrast actionSend, which refuses to send
 * unless one is already on file). That let a single ambiguous instruction
 * ("give me a draft" with no customer named) both (a) go straight to the
 * customer with zero review, and (b) land on the wrong conversation with
 * nothing to catch it, since the ack echoed back was just the sent text —
 * never the resolved contact name. Confirmed live 2026-08-06: Karenda asked
 * for a draft on Robert's escalation and got an email sent to Marissa
 * instead, with "Sent: ..." as the only feedback.
 *
 * Now this mirrors the hold flow's draft-then-confirm shape: persist the
 * revision as the conversation's proposed_reply (same is_internal note
 * shape the front-desk webhooks write at hold time — see
 * app/api/webhooks/whatsapp/route.ts's hold branch), and hand the drafted
 * text AND the resolved contact name back to the operator. Actually
 * sending it requires a separate, later "send" intent (actionSend), which
 * only ever sends a proposedReply that's already been shown once.
 *
 * Uses the workspace's voice profile (the same one caye-reply.ts uses) so the
 * revised reply still sounds like the owner. Keeps it short — WhatsApp/email
 * register, not essay.
 */
export async function actionEdit(
  ctx: ActionContext,
  intent: { item_ref?: string; instruction: string },
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  const item = resolveItemRef(pending, intent.item_ref)
  if (!item) {
    return {
      ackBody:
        pending.length === 0
          ? 'Nothing pending to edit.'
          : `Which one to edit? ${pending.map((p) => `${p.index}. ${p.contactName}`).join(' / ')}`,
      tag: { label: 'edit', status: 'failed' },
    }
  }
  if (!intent.instruction.trim()) {
    return {
      ackBody: `What change for ${item.contactName}?`,
      tag: { label: `edit ${item.contactName}`, status: 'failed' },
    }
  }

  const revised = await composeRevisedReply(ctx.workspaceId, item, intent.instruction)
  if (!revised) {
    return {
      ackBody: `Couldn't compose the edit for ${item.contactName}. Open the dashboard.`,
      tag: { label: `edit ${item.contactName}`, status: 'failed' },
    }
  }

  try {
    await stageProposedReply(item.conversationId, revised)
    return {
      ackBody: `Draft for ${item.contactName}: "${revised}"\n\nSend that?`,
      tag: { label: `edit ${item.contactName}`, status: 'ok' },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[actions/edit] stage failed:', msg)
    return {
      ackBody: `Couldn't save the draft for ${item.contactName} — ${msg.slice(0, 100)}.`,
      tag: { label: `edit ${item.contactName}`, status: 'failed' },
    }
  }
}

/**
 * Persist a revised draft as an internal note carrying metadata.proposed_reply
 * — the same shape getPendingHeldItems reads (lib/whatsapp/pending.ts). This
 * is what actionSend later sends once the operator confirms.
 */
async function stageProposedReply(conversationId: string, proposedReply: string): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase.from('unified_messages').insert({
    conversation_id: conversationId,
    channel_message_id: null,
    sender_type: 'business',
    content: proposedReply,
    message_type: 'text',
    sent_at: new Date().toISOString(),
    status: 'sent',
    is_internal: true,
    metadata: {
      generated_by: 'caye',
      hold_reason: 'operator edit',
      proposed_reply: proposedReply,
    },
  })
  if (error) throw new Error(error.message)
}

async function composeRevisedReply(
  workspaceId: string,
  item: PendingHeldItem,
  instruction: string
): Promise<string | null> {
  const supabase = createServiceClient()
  const [{ data: cfg }, { data: cust }] = await Promise.all([
    supabase
      .from('workspace_ai_config')
      .select('system_prompt')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase.from('customers').select('ai_voice_profile').eq('id', workspaceId).maybeSingle(),
  ])

  const systemPrompt =
    cfg?.system_prompt ??
    'You are a helpful assistant for a service business. Reply warmly and professionally.'
  const voice = (cust?.ai_voice_profile ?? undefined) as VoiceProfile | undefined

  let system = systemPrompt
  if (voice) {
    system +=
      `\n\nVOICE PROFILE — match this person's style:\n` +
      `- Formality: ${voice.formality_level}\n` +
      `- Style: ${voice.writing_style}\n` +
      `- Common phrases: ${voice.common_phrases.join(', ')}\n` +
      `- Greeting: ${voice.greeting_style}\n` +
      `- Sign-off: ${voice.signoff_style}\n` +
      `- Tone: ${voice.tone_notes}`
  }
  system +=
    `\n\nYou are revising a draft reply to a guest based on the owner's last-second instruction. ` +
    `Output ONLY the revised reply body — plain prose, no markdown, no quotes around it. ` +
    `Keep it short. Sign off naturally.`

  const userPrompt =
    `GUEST'S LAST MESSAGE:\n"${item.lastMessagePreview ?? '(unknown)'}"\n\n` +
    (item.proposedReply ? `ORIGINAL DRAFT:\n"${item.proposedReply}"\n\n` : '') +
    `OWNER'S INSTRUCTION:\n"${instruction}"\n\n` +
    `Write the revised reply.`

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await loggedMessagesCreate(client, {
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }, { source: 'lib/whatsapp/actions/edit.ts:composeRevisedReply', workspaceId })
    const block = response.content[0]
    if (block?.type !== 'text') return null
    return block.text.trim()
  } catch (err) {
    console.error('[actions/edit] Claude compose failed:', err)
    return null
  }
}
