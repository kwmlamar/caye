import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { detectIdentityLeak } from './caye-identity-guard'
import { sanitizeDashes } from './sanitize-dashes'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { BANNED_HEDGE_PHRASES } from './outreach-draft-guard'
import { buildTrackedDemoLink } from './outreach-compliance'

/**
 * Drafts a follow-up nudge for a cold-outreach lead in TropiTech's own
 * internal_sales workspace. Sibling to lib/caye-nudge.ts's
 * generateCayeNudge, but deliberately separate: that generator's prompt
 * frame is warm/professional "service business replying to its own
 * customer," which is the wrong register for a founder chasing a cold
 * prospect. This reuses lib/caye-reply.ts's internal_sales voice instead
 * (drawn from the workspace's own system_prompt, seeded by
 * scripts/seed-tropitech-sales-workspace.ts).
 *
 * Up to 2 follow-ups per lead as of decisions-log 2026-08-12 (was capped
 * at exactly 1) — touchNumber (2 or 3, first-touch being touch 1)
 * distinguishes "checking if you saw this" from "last one, then I'll
 * leave it" so the second nudge doesn't read like a copy-paste of the
 * first. app/api/caye/outreach-autosend-scan sends the result directly
 * (no held-for-review step) unless lib/outreach-draft-guard flags it.
 */

export interface OutreachFollowupContext {
  /** The internal_sales workspace's system_prompt (founder voice). */
  systemPrompt: string
  leadName: string
  businessName: string
  demoToken: string
  /** 2 = first follow-up (first-touch was touch 1), 3 = final follow-up. */
  touchNumber: 2 | 3
}

export type OutreachFollowupResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'identity_guard' | 'empty_response'; detail?: string }

function buildOutreachFollowupSystem(ctx: OutreachFollowupContext): string {
  const trackedLink = buildTrackedDemoLink(ctx.demoToken)
  const isFinal = ctx.touchNumber === 3
  return (
    ctx.systemPrompt +
    '\n\nTASK: Draft a short follow-up email to ' +
    `${ctx.leadName} at ${ctx.businessName}, a cold-outreach prospect who ` +
    `has not replied to the founder's ${isFinal ? 'prior two messages' : 'first-touch message sent a few days ago'}. ` +
    (isFinal
      ? 'This is the LAST allowed follow-up per TropiTech\'s outreach policy — after this, no more chasing. ' +
        'Make that plain without being harsh: this is the last check-in, not an open-ended "I\'ll keep following up."'
      : 'This is the FIRST of at most one more allowed follow-up after this one — don\'t promise or hint at ' +
        'further follow-ups beyond that.'
    ) +
    '\n\nTone: direct and brief, no re-pitching Caye from scratch, no guilt trip about the silence. ' +
    // Built from the shared ban list rather than restated inline, so the
    // instruction here and the pre-send check that enforces it (see
    // lib/outreach-draft-guard.ts) can never drift apart. A draft using any
    // of these is refused at send time, not silently shipped.
    'Skip soft American customer-service hedge phrases entirely — these exact phrases are BANNED and ' +
    'a draft containing any of them will be rejected before it sends: ' +
    BANNED_HEDGE_PHRASES.map((p) => `"${p}"`).join(', ') +
    '. This is Bahamian directness, not a ' +
    'polite reminder email. Say plainly you\'re checking whether they saw the last message, restate ' +
    'the concrete next step, done. 2-3 sentences. If they\'re not interested that\'s fine, but state ' +
    'it flat, don\'t cushion it. ' +
    `End with this exact tracked link so the click can be counted: ${trackedLink} — never invent a ` +
    'different link or fall back to a vague "I\'d love to show you what that looks like" with no link attached. ' +
    'Do not invent details about their business you don\'t already know.\n\n' +
    'Write only the email body — no subject line, no markdown. Sign as the founder, never as ' +
    '"Caye" or an AI, per the voice above.'
  )
}

export async function generateOutreachFollowupDraft(
  ctx: OutreachFollowupContext
): Promise<OutreachFollowupResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const system = buildOutreachFollowupSystem(ctx)

  const response = await loggedMessagesCreate(
    client,
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Draft the follow-up to ${ctx.leadName}.` }],
    },
    { source: 'lib/outreach-nudge.ts:generateOutreachFollowupDraft' }
  )

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
