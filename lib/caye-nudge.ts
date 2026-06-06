import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { VoiceProfile } from '@/lib/voice-profile'
import type { ContactStyleProfile } from '@/types/database'
import { detectIdentityLeak } from './caye-identity-guard'
import { sanitizeDashes } from './sanitize-dashes'

/**
 * Generates the body of a proactive nudge email. Reuses the same persona
 * infrastructure as generateCayeAutoReply (voice profile, customer style,
 * identity guard) but without the tool-use loop — a nudge is a one-shot
 * outbound message, no booking creation, no availability checks.
 *
 * Returns either { ok: true, content } with the email body to send, or
 * { ok: false, reason } when the identity guard tripped on the draft
 * (the cron caller should skip sending and log).
 */

export type NudgeKind = 'review_request' | 'ghosted_lead'

export interface NudgeContext {
  systemPrompt: string
  voiceProfile?: VoiceProfile
  contactProfile?: ContactStyleProfile
  /** Optional links injected as BUSINESS LINKS block. */
  bookingUrl?: string | null
  websiteUrl?: string | null
  /** Customer name as the recipient knows themselves. */
  customerName: string
  /** Owner-known business name for sign-off. */
  businessName: string
  /** Nudge-type-specific context. */
  kind: NudgeKind
  /** For review_request: the service taken + date. */
  reviewContext?: { service_name: string | null; booking_date: string }
  /** For ghosted_lead: the last few thread messages so Caye can reference. */
  ghostedContext?: { historyExcerpt: string }
}

export type NudgeResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'identity_guard' | 'empty_response'; detail?: string }

function buildNudgeSystem(ctx: NudgeContext): string {
  let s = ctx.systemPrompt

  if (ctx.voiceProfile) {
    s +=
      '\n\nVOICE PROFILE — write in this person\'s actual style:\n' +
      `- Formality: ${ctx.voiceProfile.formality_level}\n` +
      `- Style: ${ctx.voiceProfile.writing_style}\n` +
      `- Common phrases to use naturally: ${(ctx.voiceProfile.common_phrases ?? []).join(', ')}\n` +
      `- Typical greeting: ${ctx.voiceProfile.greeting_style}\n` +
      `- Typical sign-off: ${ctx.voiceProfile.signoff_style}\n` +
      `- Tone notes: ${ctx.voiceProfile.tone_notes}`
  }

  if (ctx.contactProfile) {
    s +=
      `\n\nCUSTOMER STYLE — adapt your reply to match this person's communication style:\n` +
      `- Formality: ${ctx.contactProfile.formality}\n` +
      `- Style: ${ctx.contactProfile.message_style}\n` +
      `- Language notes: ${ctx.contactProfile.language_notes}\n` +
      `Match their energy.`
  }

  if (ctx.bookingUrl || ctx.websiteUrl) {
    const lines: string[] = []
    if (ctx.bookingUrl) lines.push(`- Booking page: ${ctx.bookingUrl}`)
    if (ctx.websiteUrl) lines.push(`- Website: ${ctx.websiteUrl}`)
    s += '\n\nBUSINESS LINKS — include when natural, do not force:\n' + lines.join('\n')
  }

  if (ctx.kind === 'review_request') {
    const svc = ctx.reviewContext?.service_name ?? 'a recent tour'
    s +=
      `\n\nTASK: You are writing a brief, warm post-tour follow-up to ${ctx.customerName} who took ` +
      `the ${svc} with you on ${ctx.reviewContext?.booking_date ?? 'a recent date'}. Ask how the experience ` +
      `was and gently invite them to leave a Google review if they enjoyed it. ` +
      `Keep it short — 3-4 sentences max. Do NOT invent a review link; just ask for one. ` +
      `Sign off as ${ctx.businessName}'s owner using the VOICE PROFILE sign-off above.`
  } else {
    s +=
      `\n\nTASK: You are writing a brief, friendly check-in to ${ctx.customerName} who reached out ` +
      `about booking but went quiet. The recent thread looked like this:\n\n${ctx.ghostedContext?.historyExcerpt ?? '(no excerpt)'}\n\n` +
      `Politely check in. Don't push, don't apologize, don't be salesy. Just a soft "are you still ` +
      `thinking about this — happy to answer questions or help with the booking" from the owner. ` +
      `3-4 sentences max. Sign off using the VOICE PROFILE sign-off above.`
  }

  s +=
    '\n\nWrite only the email body. No subject line, no headers, no markdown. ' +
    'Plain conversational prose. Do NOT sign as "Caye" — sign as the business owner per the ' +
    'VOICE PROFILE. Never identify as AI, assistant, receptionist, or automated.'

  return s
}

export async function generateCayeNudge(ctx: NudgeContext): Promise<NudgeResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const system = buildNudgeSystem(ctx)

  const userPrompt =
    ctx.kind === 'review_request'
      ? `Write the post-tour follow-up to ${ctx.customerName}.`
      : `Write the friendly check-in to ${ctx.customerName}.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  })

  const textBlock = response.content.find(b => b.type === 'text')
  const text = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : ''

  if (!text) {
    return { ok: false, reason: 'empty_response' }
  }

  const leak = detectIdentityLeak(text)
  if (leak) {
    return { ok: false, reason: 'identity_guard', detail: leak }
  }

  return { ok: true, content: sanitizeDashes(text) }
}

/**
 * Compose a default subject line for the nudge. Per-kind heuristics
 * keep things consistent without an extra Anthropic call.
 */
export function defaultNudgeSubject(
  kind: NudgeKind,
  reviewContext?: { service_name: string | null }
): string {
  if (kind === 'review_request') {
    const svc = reviewContext?.service_name
    return svc ? `Thanks for joining us — how was the ${svc}?` : 'How was your tour?'
  }
  return 'Quick check-in'
}
