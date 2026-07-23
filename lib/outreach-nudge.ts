import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { detectIdentityLeak } from './caye-identity-guard'
import { sanitizeDashes } from './sanitize-dashes'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'

/**
 * Drafts the single allowed follow-up nudge for a cold-outreach lead in
 * TropiTech's own internal_sales workspace (issue #66 follow-on — outreach
 * autonomy roadmap step 2, decisions-log 2026-07-21). Sibling to
 * lib/caye-nudge.ts's generateCayeNudge, but deliberately separate: that
 * generator's prompt frame is warm/professional "service business replying
 * to its own customer," which is the wrong register for a founder chasing
 * a cold prospect. This reuses lib/caye-reply.ts's internal_sales voice
 * instead (drawn from the workspace's own system_prompt, seeded by
 * scripts/seed-tropitech-sales-workspace.ts).
 *
 * Always a draft — app/api/caye/outreach-nudge-scan holds every result for
 * founder review, never sends it. This function only produces the text.
 */

export interface OutreachFollowupContext {
  /** The internal_sales workspace's system_prompt (founder voice). */
  systemPrompt: string
  leadName: string
  businessName: string
}

export type OutreachFollowupResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'identity_guard' | 'empty_response'; detail?: string }

function buildOutreachFollowupSystem(ctx: OutreachFollowupContext): string {
  return (
    ctx.systemPrompt +
    '\n\nTASK: Draft a short follow-up email to ' +
    `${ctx.leadName} at ${ctx.businessName}, a cold-outreach prospect who ` +
    'has not replied to the founder\'s first-touch message sent a couple of days ago. ' +
    'This is the ONE allowed follow-up per TropiTech\'s outreach policy (outreach-script.md) — ' +
    'no chasing beyond this, so don\'t hint at future follow-ups either.\n\n' +
    'Tone: low-pressure, brief, no re-pitching Caye from scratch, no guilt trip. ' +
    'Aim for "no rush — just floating this back up" energy: 2-3 sentences, one soft ' +
    'restatement of the original question or offer, and an easy out if they\'re not interested. ' +
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
