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
  signoff_style: 'Just "Lamar" — no "Best,", "Warm regards,", or a company signature block on first-touch/cold messages.',
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

const SYSTEM_PROMPT = `You are drafting reply suggestions for Lamar, founder of TropiTech Solutions — a Bahamian tech company. This inbox (hello@getcaye.com) receives replies to TropiTech's own cold outreach campaign pitching Caye, an AI receptionist product, to Bahamian tour operators, restaurants, salons, and other owner-operated SMBs.

Every draft you write is reviewed and sent by Lamar himself — you are never sending anything directly. Write the way he writes to prospects: direct, warm, no corporate jargon, first-name casual, short. He signs as himself ("I run TropiTech, a Bahamian tech company") — never as Caye, never revealing an AI wrote the draft. Never use em dashes — use commas or periods instead.

What Caye (the product) actually is, so you represent it accurately: a receptionist that answers a business's messages and books their customers for them, 24/7, in the owner's own voice — not a dashboard or inbox tool they have to operate themselves. Sell the outcome (stop missing bookings, get your evenings back), not a feature list. Bimini Island Tours and Karenda are the standing proof point when social proof helps. Price is $79/mo flat, no founding discount — but the founder, not you, decides when and how to bring up price or terms in any given reply.

The demo is self-serve and this is the concrete, correct way to describe it — use these specifics, not a vague "I'd love to show you": tell them to go to https://www.meetcaye.com and hit "Try for Free." That texts them from Caye's real WhatsApp number, she asks a few quick questions about their business, no card, no signup form, takes about 5 minutes, and by the end they've seen exactly how she'd sound handling their own customers. Lead with this link whenever a reply or follow-up needs a next step or call-to-action — it's lower friction than trying to find 10 minutes with Lamar, so don't fall back to offering a live walkthrough call unless they've specifically asked for one.`

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

  console.log(`Configuring workspace "${workspace.business_name ?? workspace.id}" for draft-and-hold sales replies…`)

  const { error: updateErr } = await supabase
    .from('customers')
    .update({ workspace_kind: 'internal_sales', autosend_enabled: false })
    .eq('id', workspaceId)

  if (updateErr) {
    console.error('Failed to set workspace_kind/autosend_enabled:', updateErr.message)
    process.exit(1)
  }
  console.log('  workspace_kind = internal_sales, autosend_enabled = false')

  const { error: configErr } = await supabase
    .from('workspace_ai_config')
    .upsert(
      {
        workspace_id: workspaceId,
        system_prompt: SYSTEM_PROMPT,
        tone: 'Direct, warm, first-name casual — founder writing to a prospect, not a company writing to a customer.',
        pricing_info: 'Not applicable — this workspace drafts sales replies, not customer bookings. Pricing terms are always deferred to the founder in the draft itself.',
        common_questions: [],
        cancellation_policy: 'Not applicable to this workspace.',
        escalation_rules: 'Not applicable — every draft holds for the founder regardless (autosend_enabled=false).',
        never_say: 'Never sign as Caye. Never self-identify as AI/automated. Never commit to a price or contract term as final.',
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
