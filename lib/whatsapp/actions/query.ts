import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { ActionContext, ActionResult } from './types'
import type { PendingHeldItem } from '../pending'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'

/**
 * Read-only query handler. Pulls a slim slice of workspace state (pending
 * holds + today's bookings) and lets Claude compose a Caye-voice answer.
 */
export async function actionQuery(
  ctx: ActionContext,
  intent: { question: string },
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  const supabase = createServiceClient()

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, customer_name, booking_date, booking_time, status')
    .eq('user_id', ctx.workspaceId)
    .eq('booking_date', today)
    .order('booking_time', { ascending: true })

  const stateBlock = [
    pending.length
      ? 'HELD ITEMS:\n' +
        pending
          .map(
            (p) =>
              `- ${p.contactName} (${p.channelType}) — ${p.reason ?? '?'}` +
              (p.lastMessagePreview ? `\n  Guest said: "${p.lastMessagePreview}"` : '')
          )
          .join('\n')
      : 'HELD ITEMS: none.',
    bookings?.length
      ? "TODAY'S BOOKINGS:\n" +
        bookings
          .map((b) => `- ${b.customer_name} @ ${b.booking_time ?? '?'} (${b.status})`)
          .join('\n')
      : "TODAY'S BOOKINGS: none.",
  ].join('\n\n')

  const system = `You are Caye, the operator's AI assistant. Answer their question about workspace state.
VOICE: terse, lowercase ok, no emoji, no tropical metaphors, no "I'd be happy to". Sound like a quick reply over the radio.
Keep it under 3 sentences. If state is empty, say so plainly.`

  // Classifier-shape call: short structured answer, no voice generation.
  // Routed to Haiku 4.5; Sonnet fallback on empty response. Locked
  // 2026-06-24 (#47).
  const QUERY_MODEL = 'claude-haiku-4-5-20251001'
  const QUERY_FALLBACK_MODEL = 'claude-sonnet-4-6'

  const userContent = `WORKSPACE STATE:\n${stateBlock}\n\nOPERATOR ASKED:\n"${intent.question}"\n\nAnswer.`

  async function tryModel(client: Anthropic, model: string): Promise<string> {
    const response = await loggedMessagesCreate(client, {
      model,
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: userContent }],
    }, { source: 'lib/whatsapp/actions/query.ts:actionQuery', workspaceId: ctx.workspaceId })
    const block = response.content[0]
    return block?.type === 'text' ? block.text.trim() : ''
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    let text = await tryModel(client, QUERY_MODEL)
    if (!text) {
      console.warn('[actions/query] Haiku returned empty; falling back to Sonnet for this call')
      text = await tryModel(client, QUERY_FALLBACK_MODEL)
    }
    return {
      ackBody: text || "Nothing to report.",
      tag: { label: 'query', status: 'ok' },
    }
  } catch (err) {
    console.error('[actions/query] Claude failed:', err)
    return {
      ackBody: "Can't pull state right now. Open the dashboard.",
      tag: { label: 'query', status: 'failed' },
    }
  }
}

