import 'server-only'
import { renderSituationForPrompt, type CayeSituation } from '../situation'

/**
 * front-desk-situation.ts
 *
 * PHASE 1 of runtime convergence — a situation-aware system prompt for the
 * `front-desk` tool-loop mode, used ONLY by the historical replay harness
 * (`lib/caye-agent/replay/*`). No webhook imports this file.
 *
 * This is deliberately NOT `buildSystem` from `lib/caye-reply.ts` ported
 * over — that function carries the full production booking/pricing/policy
 * prompt (services catalog, autonomy decision tree, sign-off rules) built
 * for the live customer-facing tool loop, and porting it is real,
 * behavior-changing work explicitly out of scope for this phase (see the
 * convergence plan: "do not switch production front-desk traffic").
 *
 * What this file proves instead is narrower and load-bearing for Phase 1's
 * actual question — given a real `CayeSituation` (real multi-turn history,
 * real timestamps, real relationship/work-state background), does the
 * reasoning model naturally handle conversational continuity — without a
 * canned `isFirstMessage` branch telling it what to do? See
 * `lib/caye-agent/replay/fixtures/continuity-will.ts` for the case this
 * exists to evaluate.
 *
 * `lib/caye-agent/modes/front-desk.ts` remains the placeholder for the
 * eventual full extraction of `caye-reply.ts`'s production tool loop; this
 * file does not replace or modify it.
 */

export interface FrontDeskSituationPromptArgs {
  businessName: string | null
  channel: 'whatsapp' | 'instagram' | 'messenger' | 'email'
  situation: CayeSituation
  /**
   * PHASE 2 addition (2026-08-16). Set true when this call offers the
   * front-desk read-tool slice (check_availability / lookup_price /
   * find_bookings / get_services / query_business_knowledge — see
   * `lib/caye-agent/tools/read/front-desk/*`). Adds the one grounding rule
   * those tools exist to enforce; does NOT add the rest of production's
   * booking/pricing policy prose (BOOKING POLICY, AUTONOMY DECISION TREE,
   * PAYMENT COPY in `lib/caye-reply.ts`'s `buildSystem`) — porting that is
   * still out of scope, per this file's header. The tools' own
   * descriptions carry most of the procedural guidance (when to call
   * which, in what order); this only states the invariant no tool
   * description can enforce by itself.
   */
  toolsOffered?: boolean
}

export function buildFrontDeskSituationSystemPrompt(args: FrontDeskSituationPromptArgs): string {
  const business = args.businessName?.trim() || 'the business'

  const lines: string[] = [
    `You are Caye, the AI assistant handling messages for ${business} on ${args.channel}.`,
    '',
    'UNDERSTAND THE WHOLE SITUATION BEFORE YOU REPLY',
    '- You are shown the real, ordered conversation with this customer below, with a relative-time marker on each of their messages ("3 minutes ago — ...", "yesterday — ...", "on Aug 12 — ...") — use it. That marker is a fact, not a hint to interpret away.',
    '- If the conversation has been active recently, you are continuing it — reply the way a person who has been in this conversation the whole time would, and do not open with a greeting reserved for a first contact.',
    "- If the gap since the last message is genuinely long, or this is the customer's first message, a natural greeting is appropriate.",
    '- Decide this the way you would decide it in a normal conversation — from the timing and content actually in front of you, not from a rule.',
    '- Do not repeat information you already gave in this conversation unless the customer is asking again or something has changed.',
  ]

  if (args.toolsOffered) {
    lines.push(
      '',
      'GROUNDING — the one rule no tool description can enforce for you',
      '- Never state a price, an availability verdict, or an existing-booking detail you have not just retrieved with a tool THIS turn. If you have not called the relevant tool yet, call it before you say the number or the date — not after, not from memory, not from earlier in this conversation.'
    )
  }

  const situationBlock = renderSituationForPrompt(args.situation)
  if (situationBlock.trim()) {
    lines.push('', situationBlock.trim())
  }

  lines.push(
    '',
    'Write only the reply body — plain conversational prose, no markdown. Never mention that you are an AI, assistant, or automated.'
  )

  return lines.join('\n')
}
