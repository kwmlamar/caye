import 'server-only'
import { detectIdentityLeak } from './caye-identity-guard'
import { sanitizeDashes } from './sanitize-dashes'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { buildFirstTouchSystem } from './sales/voice'
import { buildTrackedDemoLink } from './outreach-compliance'

/**
 * First-touch cold-open generation.
 *
 * The prompt itself lives in lib/sales/voice.ts, which is the single source
 * of truth shared with the follow-up generator and the operator-fed
 * create_outreach_leads tool. It used to be a fourth private copy of the
 * same 4-beat structure, and the copies had already drifted apart.
 *
 * This function only produces text. Whether that text may be SENT is not
 * its business — app/api/caye/outreach-autosend-scan runs it through the
 * style guard (lib/outreach-draft-guard.ts) and the truthfulness guard
 * (lib/sales/claims.ts), and lib/sales/authority.ts decides the tier.
 */

export interface OutreachFirstTouchContext {
  /** The workspace's own voice config (customers.ai_voice_profile prose). */
  workspaceVoice: string
  leadName: string
  businessName: string
  demoToken: string
}

export type OutreachFirstTouchResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; reason: 'identity_guard' | 'empty_response' | 'unparseable'; detail?: string }

export async function generateOutreachFirstTouchDraft(
  ctx: OutreachFirstTouchContext
): Promise<OutreachFirstTouchResult> {
  const system = buildFirstTouchSystem({
    workspaceVoice: ctx.workspaceVoice,
    leadName: ctx.leadName,
    businessName: ctx.businessName,
    trackedLink: buildTrackedDemoLink(ctx.demoToken),
  })

  const response = await loggedMessagesCreate(
    null,
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: `Write the first-touch email to ${ctx.leadName} at ${ctx.businessName}.` },
      ],
    },
    { source: 'lib/outreach-first-touch.ts:generateOutreachFirstTouchDraft', task: 'outreach' }
  )

  const textBlock = response.content.find((b) => b.type === 'text')
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : ''
  if (!raw) return { ok: false, reason: 'empty_response' }

  const match = raw.match(/^SUBJECT:\s*(.+?)\s*\n---\s*\n([\s\S]+)$/)
  if (!match) return { ok: false, reason: 'unparseable', detail: raw.slice(0, 200) }

  const subject = match[1].trim()
  const body = sanitizeDashes(match[2].trim())
  if (!subject || !body) return { ok: false, reason: 'empty_response' }

  const leak = detectIdentityLeak(body) || detectIdentityLeak(subject)
  if (leak) return { ok: false, reason: 'identity_guard', detail: leak }

  return { ok: true, subject, body }
}
