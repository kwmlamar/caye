import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { VoiceProfile } from '@/lib/voice-profile'

export type CayeAutoReply =
  | { action: 'reply'; content: string }
  | { action: 'hold'; reason: string; note: string }

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'send_reply',
    description:
      'Send a reply to the customer. Use this when you can confidently handle the message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'The reply to send to the customer.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'hold_for_human',
    description:
      'Hold this conversation for the business owner to handle personally. Use this when: ' +
      'the customer has a complaint or is upset; the request needs specific info you don\'t have ' +
      '(exact pricing, custom quotes, special arrangements); the customer is ready to book and ' +
      'needs a human to confirm; the message is ambiguous and risky to answer wrong; or anything ' +
      'that feels like it needs a human touch.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description:
            'One short sentence — why you are stepping back. Shown in the inbox as a label.',
        },
        note: {
          type: 'string',
          description:
            'A brief internal note for the business owner. Write it like a handoff: what the ' +
            'customer needs, any relevant context, what you\'d suggest doing. 2-4 sentences max.',
        },
      },
      required: ['reason', 'note'],
    },
  },
]

function buildSystem(
  systemPrompt: string,
  voiceProfile: VoiceProfile | undefined,
  channel: string,
  isEmail: boolean
): string {
  let s = systemPrompt

  if (voiceProfile) {
    s +=
      '\n\nVOICE PROFILE — write in this person\'s actual style:\n' +
      `- Formality: ${voiceProfile.formality_level}\n` +
      `- Style: ${voiceProfile.writing_style}\n` +
      `- Common phrases to use naturally: ${(voiceProfile.common_phrases ?? []).join(', ')}\n` +
      `- Typical greeting: ${voiceProfile.greeting_style}\n` +
      `- Typical sign-off: ${voiceProfile.signoff_style}\n` +
      `- Tone notes: ${voiceProfile.tone_notes}`
  }

  s += isEmail
    ? '\n\nWrite only the reply body — no headers, no markdown. Plain prose, sign off naturally.'
    : `\n\nWrite only the reply body. Plain conversational prose — no markdown. Keep it brief — this is ${channel}, not email.`

  s +=
    '\n\nYou MUST call either send_reply or hold_for_human. Never respond with plain text.'

  return s
}

/**
 * Core Caye auto-reply engine used by all channel webhooks.
 * Returns either a reply to send or a hold decision with an owner note.
 */
export async function generateCayeAutoReply(
  systemPrompt: string,
  inbound: {
    senderName: string
    body: string
    channel: 'whatsapp' | 'instagram' | 'messenger' | 'email'
    subject?: string
  },
  voiceProfile?: VoiceProfile
): Promise<CayeAutoReply> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const isEmail = inbound.channel === 'email'

  const userContent = isEmail
    ? `Reply to this email:\n\nFrom: ${inbound.senderName}\nSubject: ${inbound.subject || '(no subject)'}\n\n${inbound.body}`
    : `Reply to this ${inbound.channel} message:\n\nFrom: ${inbound.senderName}\n\n${inbound.body}`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: buildSystem(systemPrompt, voiceProfile, inbound.channel, isEmail),
    tools: TOOLS,
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: userContent }],
  })

  for (const block of response.content) {
    if (block.type !== 'tool_use') continue

    if (block.name === 'send_reply') {
      const input = block.input as { content: string }
      return { action: 'reply', content: input.content }
    }

    if (block.name === 'hold_for_human') {
      const input = block.input as { reason: string; note: string }
      return { action: 'hold', reason: input.reason, note: input.note }
    }
  }

  // Fallback: if no tool was called, use any text content as a reply
  const textBlock = response.content.find((b) => b.type === 'text')
  if (textBlock && textBlock.type === 'text' && textBlock.text.trim()) {
    return { action: 'reply', content: textBlock.text }
  }

  throw new Error('[caye-reply] No tool call or text in Claude response')
}
