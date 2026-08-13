import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { detectIdentityLeak } from './caye-identity-guard'
import { sanitizeDashes } from './sanitize-dashes'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { buildFollowupSystem } from './sales/voice'
import { buildTrackedDemoLink } from './outreach-compliance'

/**
 * Follow-up generation for touch 2 or 3 of the cold cadence.
 *
 * Prompt lives in lib/sales/voice.ts, shared with the first-touch
 * generator. `touchNumber` changes the framing — "checking you saw this"
 * versus "this is the last one" — so the final touch does not read as a
 * copy of the first.
 *
 * Produces text only. Send authority is decided by lib/sales/authority.ts,
 * and the draft is checked by lib/outreach-draft-guard.ts and
 * lib/sales/claims.ts before anything ships.
 */

export interface OutreachFollowupContext {
  workspaceVoice: string
  leadName: string
  businessName: string
  demoToken: string
  /** 2 = first follow-up (first touch was 1), 3 = final. */
  touchNumber: 2 | 3
}

export type OutreachFollowupResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'identity_guard' | 'empty_response'; detail?: string }

export async function generateOutreachFollowupDraft(
  ctx: OutreachFollowupContext
): Promise<OutreachFollowupResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const system = buildFollowupSystem({
    workspaceVoice: ctx.workspaceVoice,
    leadName: ctx.leadName,
    businessName: ctx.businessName,
    trackedLink: buildTrackedDemoLink(ctx.demoToken),
    touchNumber: ctx.touchNumber,
  })

  const response = await loggedMessagesCreate(
    client,
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Write the follow-up to ${ctx.leadName}.` }],
    },
    { source: 'lib/outreach-nudge.ts:generateOutreachFollowupDraft' }
  )

  const textBlock = response.content.find((b) => b.type === 'text')
  const text = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : ''
  if (!text) return { ok: false, reason: 'empty_response' }

  const leak = detectIdentityLeak(text)
  if (leak) return { ok: false, reason: 'identity_guard', detail: leak }

  return { ok: true, content: sanitizeDashes(text) }
}
