import { buildBackOfficeSystemPrompt } from '../../modes/back-office'
import { fakeReadTool, fakeWriteTool, fixtureCtx, SEND_REPLY_SCHEMA } from './helpers'
import type { ReplayTurnInput } from '../types'

/**
 * REAL HISTORY — Pam, reconstructed from actual production data.
 *
 * Read directly from `caye_operator_messages` / `caye_tool_calls` for the
 * real Bimini workspace, read-only (2026-08-17 investigation into the
 * operator-channel-continuity incident). This is the verbatim turn where
 * the bug actually fired: Mrs. Max, managing Caye entirely from WhatsApp,
 * asks for a revised quote "draft please." The real production response
 * (on the prompt as it existed before this fix) silently called
 * `draft_in_inbox` and told her to go open her email — she never once
 * asked for anything to be filed there; every one of her messages just
 * said "draft please."
 *
 * PII SCRUBBED: the real thread carries the customer's surname, her email
 * thread's exact channel id, and Mrs. Max's own contact details. None of
 * that is reproduced here — only her first name (already how the incident
 * report itself refers to her) and the business facts (pricing, tour
 * names) needed to reconstruct the scenario.
 *
 * WHAT THIS FIXTURE CHECKS
 * With BOTH send_reply and draft_in_inbox available and nothing in Mrs.
 * Max's message asking for anything to be filed into her email, does the
 * candidate prompt (COMPOSING A DRAFT VS. FILING AN EXTERNAL ONE, added
 * this fix) produce a `send_reply` call — the full draft shown inline —
 * rather than `draft_in_inbox`? Construction only; see fixtures.test.ts's
 * header comment for why live-model verification is a separate, manual
 * step from this file's own tests.
 */
export function buildRealPamOttDraftChannelFixture(): ReplayTurnInput {
  const getCustomer = fakeReadTool(
    'get_customer',
    'Look up a customer by name, phone, or email.',
    {
      matches: [
        {
          conversation_id: 'conv_pam_real',
          customer_name: 'Pam',
          channel: 'email',
          channel_conversation_id: 'chan_pam_real',
        },
      ],
    }
  )
  const getServices = fakeReadTool('get_services', 'List the full service catalog with pricing tiers.', {
    services: [
      {
        name: 'Full Bimini Experience',
        tiers: [
          { label: 'Shared (per person)', price: 199 },
          { label: 'Private Couple (2)', price: 450 },
        ],
      },
      {
        name: 'North Bimini Heritage',
        tiers: [{ label: 'Shared only (per person)', price: 175 }],
      },
    ],
  })
  const queryBusinessKnowledge = fakeReadTool(
    'query_business_knowledge',
    "Look up what Caye knows about a topic from the business_facts knowledge base.",
    { matched: 0, items: [] }
  )
  const sendReply = fakeWriteTool(
    'send_reply',
    'Send a reply to a customer on their thread. HIGH-RISK.',
    'high',
    ['owner', 'founder'],
    SEND_REPLY_SCHEMA
  )
  const draftInInbox = fakeWriteTool(
    'draft_in_inbox',
    "Files a draft into the operator's OWN external email Drafts folder instead of showing it here. HIGH-RISK.",
    'high',
    ['owner', 'founder'],
    SEND_REPLY_SCHEMA
  )

  const systemPrompt = buildBackOfficeSystemPrompt({
    profile: { operatorName: 'Mrs. Max', businessName: 'Bimini Island Tours' },
    caller: { role: 'owner', name: 'Mrs. Max' },
  })

  const messages = [
    {
      role: 'user' as const,
      content: 'are you able to provide them with an overview and cost of the full bimini tour (Draft please)',
    },
    {
      role: 'assistant' as const,
      content:
        'Pam is 2 guests. Here\'s the draft:\n\n---\n\nDear Pam,\n\nThank you for your interest in the Full ' +
        'Bimini Experience...\n\nPricing for 2 guests: $199 per person (shared) — $398 total.\n\n---\n\nSend that?',
    },
    { role: 'user' as const, content: 'private is the option shared is $199 and at the moment we do not have any other booking' },
    {
      role: 'assistant' as const,
      content:
        'Got it — private is the right option with no other bookings to hit the shared minimum. What\'s the private rate for 2 guests?',
    },
    {
      role: 'user' as const,
      content: '$225 per person and give them option for the North Bimini Heritage as well draft please',
    },
  ]

  return {
    meta: {
      caseId: 'real-pam-ott-draft-channel',
      label: 'REAL — Pam, "draft please" must stay inline, never file to email drafts',
      description:
        'Verbatim owner text from real production history (2026-08-17, PII scrubbed): "$225 per person and ' +
        'give them option for the North Bimini Heritage as well draft please." On the pre-fix prompt this ' +
        'silently called draft_in_inbox and told the owner to open her email — she never asked for anything ' +
        'to be filed there, only ever said "draft please." Checks whether the candidate prompt (COMPOSING A ' +
        'DRAFT VS. FILING AN EXTERNAL ONE, added this fix) keeps the draft inline via send_reply instead, on ' +
        'a customer whose own thread happens to be email.',
    },
    mode: 'back-office',
    systemPrompt,
    messages,
    ctx: fixtureCtx({ callerRole: 'owner' }),
    tools: [getCustomer, getServices, queryBusinessKnowledge, sendReply, draftInInbox],
  }
}
