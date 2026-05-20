import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { VoiceProfile } from '@/lib/voice-profile'

/**
 * Generates a WhatsApp reply using Claude claude-sonnet-4-6.
 */
export async function generateWhatsAppReply(
  systemPrompt: string,
  inbound: { senderName: string; body: string },
  voiceProfile?: VoiceProfile
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let fullSystem = systemPrompt

  if (voiceProfile) {
    fullSystem +=
      '\n\nVOICE PROFILE — write in this person\'s actual style:\n' +
      `- Formality: ${voiceProfile.formality_level}\n` +
      `- Style: ${voiceProfile.writing_style}\n` +
      `- Common phrases to use naturally: ${voiceProfile.common_phrases.join(', ')}\n` +
      `- Typical greeting: ${voiceProfile.greeting_style}\n` +
      `- Typical sign-off: ${voiceProfile.signoff_style}\n` +
      `- Tone notes: ${voiceProfile.tone_notes}`
  }

  fullSystem +=
    '\n\nWrite only the reply body. Plain conversational prose — no markdown, no bullet points, no headers. ' +
    'Keep it brief — WhatsApp, not email. Sign off naturally.'

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: fullSystem,
    messages: [
      {
        role: 'user',
        content: `Reply to this WhatsApp message:\n\nFrom: ${inbound.senderName}\n\n${inbound.body}`,
      },
    ],
  })

  const block = response.content[0]
  if (block.type !== 'text') {
    throw new Error(`Unexpected Claude response block type: ${block.type}`)
  }
  return block.text
}

/**
 * Sends a WhatsApp message via the Meta Cloud API.
 */
export async function sendWhatsAppMessage(
  to: string,
  body: string,
  phoneNumberId: string,
  accessToken: string
): Promise<void> {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body },
      }),
    }
  )

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(
      `Meta WhatsApp API error (HTTP ${res.status}) sending to ${to}: ${detail.slice(0, 300)}`
    )
  }
}
