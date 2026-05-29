import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { ActionContext, ActionResult } from './types'
import type { PendingHeldItem } from '../pending'

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

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system,
      messages: [
        {
          role: 'user',
          content: `WORKSPACE STATE:\n${stateBlock}\n\nOPERATOR ASKED:\n"${intent.question}"\n\nAnswer.`,
        },
      ],
    })
    const block = response.content[0]
    const text = block?.type === 'text' ? block.text.trim() : ''
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

