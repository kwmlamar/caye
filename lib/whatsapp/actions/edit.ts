import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { dispatchOperatorReply } from '../channel-dispatch'
import { resolveItemRef, type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'
import type { VoiceProfile } from '@/lib/voice-profile'

/**
 * Compose a revised draft per the operator's instruction, then send.
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
    await dispatchOperatorReply(item.conversationId, revised)
    return {
      ackBody: `Sent: "${revised.slice(0, 60)}${revised.length > 60 ? '…' : ''}"`,
      tag: { label: `edit ${item.contactName}`, status: 'ok' },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[actions/edit] dispatch failed:', msg)
    return {
      ackBody: `Couldn't send the edit to ${item.contactName} — ${msg.slice(0, 100)}.`,
      tag: { label: `edit ${item.contactName}`, status: 'failed' },
    }
  }
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
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const block = response.content[0]
    if (block?.type !== 'text') return null
    return block.text.trim()
  } catch (err) {
    console.error('[actions/edit] Claude compose failed:', err)
    return null
  }
}
