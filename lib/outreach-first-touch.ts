import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { detectIdentityLeak } from './caye-identity-guard'
import { sanitizeDashes } from './sanitize-dashes'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { BANNED_HEDGE_PHRASES } from './outreach-draft-guard'
import { buildTrackedDemoLink } from './outreach-compliance'

/**
 * Standalone first-touch cold-opener generator for the autonomous sourcing
 * pipeline (app/api/caye/outreach-autosend-scan). Reuses the 4-beat
 * structure and rules from lib/caye-agent/tools/write-low/create-outreach-
 * leads.ts's tool description almost verbatim — that text represents real
 * tuning across several live batches (2026-07-23 through 2026-07-30), not
 * a fresh guess — but is called directly rather than left as instructions
 * for an operator-invoked LLM tool turn, since autonomous sourcing has no
 * human in the loop composing it live.
 *
 * Caribbean-only for now: every seed row in outreach_sourcing_targets
 * (20260812_outreach_autonomy.sql) is a Caribbean region by construction
 * (decisions-log 2026-08-12 — sourcing stays bounded to the documented
 * ICP), so the geography-conditional beats (2)/(3) always use the
 * Caribbean/Bahamian framing here. If a non-Caribbean target is ever added
 * to that table, this needs a region-aware branch — flagged rather than
 * silently guessed at.
 */

export interface OutreachFirstTouchContext {
  systemPrompt: string
  leadName: string
  businessName: string
  demoToken: string
}

export type OutreachFirstTouchResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; reason: 'identity_guard' | 'empty_response' | 'unparseable'; detail?: string }

function buildFirstTouchSystem(ctx: OutreachFirstTouchContext): string {
  const trackedLink = buildTrackedDemoLink(ctx.demoToken)
  return (
    ctx.systemPrompt +
    '\n\nTASK: Write a cold-opener first-touch email to ' +
    `${ctx.leadName} at ${ctx.businessName}, a prospect who has never heard from us. ` +
    'Respond in EXACTLY this format, nothing else:\n' +
    'SUBJECT: <short, plain subject line, no clickbait, no emoji>\n' +
    '---\n' +
    '<email body>\n\n' +
    'STRUCTURE — exactly 4 beats, in order: ' +
    '(1) HOOK — one sentence, personalized: name the business, then state a confident, un-hedged truth ' +
    'about their situation. Never guess or soften with "probably", "likely", "I\'d guess". ' +
    '(2) SELF-ID + WHAT CAYE DOES — Caribbean framing: "I\'m Lamar, founder of TropiTech, a Bahamian tech ' +
    'company. I built Caye." Never say "AI", "automation", or "LLM" anywhere — describe the job, not the ' +
    'category. Never a bare label ("an assistant", "a chatbot", "an AI employee/teammate", "a receptionist"). ' +
    'Keep it short and visual: "She lives in WhatsApp, making sure every customer gets a reply before they ' +
    'give up and move on." Never promise a specific business outcome you can\'t verify. ' +
    '(3) PROOF — one real business already using her (never overclaim more than the one real paying ' +
    'customer). Say "She\'s already working alongside another Bahamian business every day" unless the ' +
    'lead is itself a tour operator, in which case naming "another tour operator" is fine. ' +
    `(4) CTA — one short, conversational close ending with this exact tracked link so it can be counted: ${trackedLink} ` +
    '— e.g. "Want to see it in action? ' + trackedLink + '" Never a bare link with no question, never "Interested?" alone.\n\n' +
    'CLARITY — 8th-grade reading level, every sentence understandable in under two seconds. ' +
    'PERSONALIZATION — exactly ONE sentence (the HOOK) is personalized; beats (2)-(4) should be near-identical ' +
    'wording across a batch — vary the HOOK\'s opening structure/verb, but never pad it into a generic category ' +
    'truism that could paste into any business\'s email unchanged. ' +
    'No em dashes and no manual "--" standing in for one. ' +
    'Sign-off is "Lamar" alone — never a second line with the company name. ' +
    'Never invent scarcity — no fabricated beta-spot counts or deadlines; the self-serve demo is always available. ' +
    'LENGTH — target 50-70 words total, hard cap 90 (word count, not sentence count). ' +
    'Skip soft American customer-service hedge phrases entirely — these exact phrases are BANNED: ' +
    BANNED_HEDGE_PHRASES.map((p) => `"${p}"`).join(', ') + '. ' +
    'Do not invent details about their business you don\'t already know. Sign as the founder, never as ' +
    '"Caye" or an AI.'
  )
}

export async function generateOutreachFirstTouchDraft(
  ctx: OutreachFirstTouchContext
): Promise<OutreachFirstTouchResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const system = buildFirstTouchSystem(ctx)

  const response = await loggedMessagesCreate(
    client,
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Write the first-touch email to ${ctx.leadName} at ${ctx.businessName}.` }],
    },
    { source: 'lib/outreach-first-touch.ts:generateOutreachFirstTouchDraft' }
  )

  const textBlock = response.content.find(b => b.type === 'text')
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
