/**
 * One-off: configure TropiTech's own workspace (hello@getcaye.com) for
 * draft-and-hold cold-outreach reply assistance (issue #66).
 *
 * This does NOT create the workspace or connect Zoho — do that first via
 * the normal signup + "connect email" flow in the browser (no bespoke UI
 * for this per Products/Caye/CLAUDE.md's anti-patterns; the discovery
 * interview is intentionally skipped since pricing/cancellation-policy/FAQ
 * questions don't apply to a sales inbox — see issue #66).
 *
 * What this script does, given the resulting workspace id:
 *   1. Sets customers.workspace_kind = 'internal_sales' and
 *      customers.autosend_enabled = false — this is what makes
 *      generateCayeAutoReply use the sales tool list / prompt frame
 *      (lib/caye-reply.ts) and forces every decision through
 *      lib/autosend-gate.ts.
 *   2. Upserts a hand-authored workspace_ai_config.system_prompt (founder
 *      voice, drawn from outreach-script.md / outreach/log.md) instead of
 *      running the AI discovery interview.
 *   3. Upserts customers.ai_voice_profile (2026-07-23, grilled) — a
 *      SEPARATE channel from workspace_ai_config.system_prompt above.
 *      buildBackOfficeSystemPrompt (lib/caye-agent/modes/back-office.ts)
 *      never reads workspace_ai_config at all; it only reads
 *      customers.ai_voice_profile, which was null for this workspace until
 *      this step existed. That gap meant the back-office agent — which is
 *      what actually handles create_outreach_leads — had zero tone/register
 *      signal when drafting cold-outreach copy, confirmed as the root
 *      cause of a real batch of drafts reading like generic LinkedIn
 *      prospecting instead of Lamar's actual voice. Content below is
 *      calibrated against his own real sent messages (see decisions-log),
 *      not an invented description of "casual tone."
 *
 * Run with (dotenv isn't installed in this repo — source env vars directly):
 *   set -a && source .env.local && set +a && npx tsx scripts/seed-tropitech-sales-workspace.ts <workspaceId>
 */

import { createClient } from '@supabase/supabase-js'
import type { VoiceProfile } from '@/lib/voice-profile'

const VOICE_PROFILE: VoiceProfile = {
  writing_style:
    "Short, direct sentences. Casual asides mixed in naturally (e.g. \"Haha yes, that's my dad\"). " +
    'Reads like a text message or a quick voice note, not a marketing email — no corporate/analytical ' +
    'framing ("is no small thing", "a real operational challenge", "that\'s a diverse itinerary"). Gets ' +
    'to the point fast.',
  common_phrases: [
    "I'm Lamar with TropiTech",
    'I run TropiTech, a Bahamian tech company',
    'no commitment',
    'worth a look',
    'want me to show you',
  ],
  greeting_style: 'First name only ("Hey [name]" or "Hey,") — never "Dear" or a formal salutation.',
  signoff_style: 'Just "Lamar" — never a company name on a second line, on any prospect-facing message.',
  formality_level: 'casual',
  tone_notes:
    'Voice-note friendly per outreach-script.md — short, conversational, like texting someone, not ' +
    'pitching in a boardroom. Reference (his own real sent messages, the calibration standard): ' +
    '"Haha yes, that\'s my dad. Small island, good to actually connect with someone who knows him." and ' +
    '"Hey, thanks for the quick reply, but I should clarify: I\'m not looking to book a rental. I\'m ' +
    'Lamar with TropiTech." Always states who he is up front (see common_phrases) rather than jumping ' +
    "straight into an observation about the business. Never uses em dashes — commas or periods only.",
  signature_block: null,
  tagline: null,
  standard_signoff: 'Lamar',
  // Deliberately null, not verbatim — first-touch opens must vary per
  // lead's specific situation (2026-07-23 grilled finding: identical
  // structure across a batch is exactly the "reads as bulk outreach" tell).
  standard_opener: null,
}

/**
 * Scope note (2026-08-12): this prompt describes VOICE and CONTEXT only.
 *
 * It deliberately no longer contains authority rules ("Lamar reviews every
 * draft"), pricing policy ("the founder decides when to bring up price"),
 * or cadence. All three were false at the time they were being fed to a
 * model that was in fact sending autonomously, and prose in a prompt cannot
 * enforce a rule anyway. Policy now lives in lib/sales/{authority,
 * next-action,claims,facts}.ts where it is deterministic and unit-tested,
 * and the outbound style rules live in lib/sales/voice.ts.
 *
 * Anything added back here that grants or withdraws authority will be
 * ignored by the code and will only serve to contradict it.
 */
const SYSTEM_PROMPT = `You are Caye, working sales for TropiTech Solutions, a Bahamian tech company founded by Lamar. This inbox (hello@getcaye.com) is your desk. It carries your own cold outreach to owner-operated small businesses, mostly Caribbean tour operators, restaurants, salons and guesthouses, and the replies that come back.

You are responsible for an outcome, not a task list: get Caye in front of owners who would genuinely benefit from her, and move the interested ones toward actually trying her. Sending an email is not success. A reply is not success. Someone trying Caye and becoming a customer is success. Judge your own work against that.

You write as Lamar. He signs as himself, first name only. You never sign as Caye and you never claim in writing to be a person. If a prospect asks you directly whether they are talking to a human or an AI, tell them the truth plainly and carry on. Never deny it and never dodge it. Not leading with the technology is a marketing choice; lying about what you are would destroy the exact trust this product is sold on.

What you are selling: Caye is a hire, not a tool. She answers a business's messages and books their customers, around the clock, in the owner's own voice, and she is not a dashboard the owner has to learn and operate. Sell what having her feels like, which is that customers get answered, leads stop disappearing, bookings stop getting forgotten, follow-ups actually happen, and the owner gets their evenings back. Describe the job, not the category, and never recite a feature list.

Voice: short, direct, conversational, Bahamian business register rather than American customer service. Confident without hype. No em dashes, commas or periods instead. Never invent urgency, deadlines or scarcity.

Two things you must never do. Never state anything about price, customers, capabilities or integrations that you have not been given as a verified fact, and if you do not know, say you will check rather than filling the gap. Never make a commitment that is not yours to make, including discounts, custom terms, contracts, refunds or partnerships, all of which go to Lamar.`

async function main() {
  const workspaceId = process.argv[2]
  if (!workspaceId) {
    console.error('Usage: npx tsx scripts/seed-tropitech-sales-workspace.ts <workspaceId>')
    process.exit(1)
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: workspace, error: fetchErr } = await supabase
    .from('customers')
    .select('id, business_name')
    .eq('id', workspaceId)
    .maybeSingle()

  if (fetchErr || !workspace) {
    console.error(`No workspace found for id ${workspaceId}:`, fetchErr?.message ?? '(not found)')
    process.exit(1)
  }

  console.log(`Configuring workspace "${workspace.business_name ?? workspace.id}" for autonomous sales…`)

  // autosend_enabled = true since 2026-08-12: Caye answers prospects who
  // write back without a human in between. Cold OUTBOUND is gated
  // separately by workspace_ai_config.outreach_autosend_paused, which this
  // script deliberately does not touch — re-seeding voice config must never
  // silently switch cold sending on.
  const { error: updateErr } = await supabase
    .from('customers')
    .update({ workspace_kind: 'internal_sales', autosend_enabled: true })
    .eq('id', workspaceId)

  if (updateErr) {
    console.error('Failed to set workspace_kind/autosend_enabled:', updateErr.message)
    process.exit(1)
  }
  console.log('  workspace_kind = internal_sales, autosend_enabled = true')

  const { error: configErr } = await supabase
    .from('workspace_ai_config')
    .upsert(
      {
        workspace_id: workspaceId,
        system_prompt: SYSTEM_PROMPT,
        tone: 'Direct, warm, first-name casual — founder writing to a prospect, not a company writing to a customer.',
        pricing_info: 'Price facts live in lib/sales/facts.ts (SALES_FACTS) and are injected at generation time, so they can also be checked against the finished draft by lib/sales/claims.ts. Do not restate a price here; a second copy is a second thing to go stale.',
        common_questions: [],
        cancellation_policy: 'Not applicable to this workspace.',
        escalation_rules: 'Enforced in code, not prose: lib/sales/escalation-triggers.ts matches the categories (pricing negotiation, legal, partnership, press, refunds, security, large accounts, complaints) and lib/sales/authority.ts routes them to the founder before the model is consulted.',
        never_say: 'Never sign as Caye. Never claim in writing to be a person, but answer honestly if asked directly whether you are an AI. Never commit to a price, discount or contract term.',
        raw_onboarding_answers: [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id' }
    )

  if (configErr) {
    console.error('Failed to upsert workspace_ai_config:', configErr.message)
    process.exit(1)
  }
  console.log('  workspace_ai_config.system_prompt seeded')

  const { error: voiceErr } = await supabase
    .from('customers')
    .update({ ai_voice_profile: VOICE_PROFILE })
    .eq('id', workspaceId)

  if (voiceErr) {
    console.error('Failed to upsert ai_voice_profile:', voiceErr.message)
    process.exit(1)
  }
  console.log('  customers.ai_voice_profile seeded (reaches the back-office agent — create_outreach_leads, etc.)')

  console.log('\nDone. Before connecting hello@getcaye.com to live traffic, run the rollout checks from issue #66:')
  console.log('  1. npx vitest run lib/autosend-gate.test.ts')
  console.log('  2. Send one real email to hello@getcaye.com and confirm it lands in HeldScreen as a draft, nothing sends.')
}

main()
