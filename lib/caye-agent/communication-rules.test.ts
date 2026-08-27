import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { buildBackOfficeSystemPrompt } from './modes/back-office'
import { buildMorningBriefingPrompt, buildEodSummaryPrompt } from './briefing'
import { TOOL_REGISTRY } from './tools/registry'
import { renderAttentionContext } from '@/lib/owner-attention'
import { detectInternalLeak } from '@/lib/operator-text-guard'

/**
 * These assert the RULES Caye operates under, not the sentences she produces.
 *
 * An LLM's output can't be pinned in a unit test, but the instructions it is
 * given can be — and every defect in the 2026-08-12 transcript traced back to
 * an instruction rather than to sampling. "Exactly ONE concrete yes/no
 * question" made Caye invent an errand for the owner every morning for weeks
 * and nothing caught it, because the prompt lived inline in a function that
 * also made a network call. That is the gap these close.
 */

type PromptArgs = Parameters<typeof buildBackOfficeSystemPrompt>[0]

const prompt = (over: Partial<PromptArgs> = {}) =>
  buildBackOfficeSystemPrompt({
    profile: { operatorName: 'Karenda', businessName: 'Bimini Island Tours' },
    caller: { role: 'owner', name: 'Mrs. Max' },
    ...over,
  })

describe('back-office prompt — autonomy is derived from the risk tiers', () => {
  const backOffice = TOOL_REGISTRY.filter((t) => t.modes.includes('back-office'))
  const lowRisk = backOffice.filter((t) => t.risk === 'low').map((t) => t.name)
  const highRisk = backOffice.filter((t) => t.risk === 'high').map((t) => t.name)

  it('names every low-risk tool as execute-without-asking', () => {
    // Requirement 7, generalised. Derived from the registry, so a tool added
    // as `low` tomorrow is covered without anyone editing prose.
    const p = prompt()
    expect(lowRisk.length).toBeGreaterThan(0)
    for (const name of lowRisk) {
      expect(p, `${name} should be listed as low-risk`).toContain(name)
    }
    expect(p).toMatch(/LOW-RISK WRITES execute immediately and need NO permission/)
    expect(p).toMatch(/State them, don't ask/)
  })

  it('bans permission-seeking for work Caye is already authorised to do', () => {
    const p = prompt()
    expect(p).toMatch(/NEVER "would you like me to archive that\?"/)
    expect(p).toMatch(/asking for it back is the single most junior thing you can do/)
  })

  it('requires a recommendation and one question for high-risk writes', () => {
    // Requirement 8.
    const p = prompt()
    expect(highRisk.length).toBeGreaterThan(0)
    for (const name of highRisk) {
      expect(p, `${name} should be listed as high-risk`).toContain(name)
    }
    expect(p).toMatch(/present it with a recommendation and ONE question/)
    expect(p).toMatch(/Never an open menu of options, never two questions at once/)
  })

  it('carries the worked example of withholding with a counter-offer', () => {
    expect(prompt()).toMatch(/I haven't agreed to anything\. I'd offer 10%/)
  })

  it('does not leave the old one-off exception behind as the only such rule', () => {
    // The "don't ask, just do it" instruction used to exist on exactly one
    // tool. If that sentence is the ONLY place autonomy is asserted, the
    // generalisation has been reverted.
    const p = prompt()
    expect(p).not.toMatch(/call this immediately, don't ask "want me to send it\?" first/)
    expect(p).toMatch(/AUTONOMY — AUTONOMOUS BY DEFAULT, ESCALATE BY EXCEPTION/)
  })

  it('states when to escalate and when not to', () => {
    const p = prompt()
    expect(p).toMatch(/ESCALATE only when the decision commits money/)
    expect(p).toMatch(/isn't finished until .* can decide from your message alone/)
  })
})

describe('back-office prompt — no process narration', () => {
  it('bans the exact phrases from the 2026-08-12 transcript', () => {
    const p = prompt()
    for (const banned of [
      'Let me check…',
      "I'll look into…",
      'at the same time',
      'in parallel',
      'Based on my analysis…',
      'Certainly!',
    ]) {
      expect(p, `should ban "${banned}"`).toContain(banned)
    }
    expect(p).toMatch(/report the state of the BUSINESS, never the state of your own work/)
  })

  it('bans naming internal machinery to the operator', () => {
    const p = prompt()
    expect(p).toMatch(/Never name your own machinery/)
    expect(p).toMatch(/the held queue/)
    expect(p).toMatch(/hired a person, not a database/)
  })

  it('bans bracketed system tokens in prose', () => {
    expect(prompt()).toMatch(/Never emit a bracketed system token/)
  })

  it('forbids padding a clean result', () => {
    const p = prompt()
    expect(p).toMatch(/Don't pad a clean result/)
    expect(p).toMatch(/No recap of what you looked at, no third restatement, no exclamation mark/)
  })

  it('forbids reporting its own compliance as reassurance', () => {
    expect(prompt()).toMatch(/Don't report your own good behaviour/)
  })
})

describe('back-office prompt — attention classification and certainty', () => {
  it('defines the five tiers and caps decisions per message', () => {
    const p = prompt()
    for (const tier of ['CRITICAL', 'DECISION', 'AWARENESS', 'ROUTINE', 'NOISE']) {
      expect(p).toContain(tier)
    }
    expect(p).toMatch(/One CRITICAL or DECISION per message, maximum/)
  })

  it('forbids a question mark on an awareness item', () => {
    expect(prompt()).toMatch(/NO question mark — a question turns it into a decision/)
  })

  it('separates facts, inferences and recommendations', () => {
    const p = prompt()
    expect(p).toMatch(/A fact you got from a tool: state it flat/)
    expect(p).toMatch(/An inference: mark it as one/)
    expect(p).toMatch(/A recommendation: own it in first person/)
    expect(p).toMatch(/hedging verified data throws away the value of having checked/)
  })

  it('distinguishes an empty tool result from a policy', () => {
    expect(prompt()).toMatch(/never means "we don't do that"/)
  })
})

describe('back-office prompt — proactive scans cannot contradict past pings', () => {
  const ATTENTION = [
    'ATTENTION STATE',
    'ALREADY TOLD, NOTHING CHANGED (1) — do NOT re-explain or re-raise as new.',
    '  - Ruslan Prakapovich — B2B partnership [decision]',
    'The owner is NOT clear. Do not say "nothing needs your attention" or anything equivalent.',
  ].join('\n')

  it('injects attention state on a scan', () => {
    const p = prompt({ origin: 'scan', attentionContext: ATTENTION })
    expect(p).toContain('WHAT YOU HAVE ALREADY TOLD THEM')
    expect(p).toContain('Ruslan Prakapovich — B2B partnership')
    expect(p).toMatch(/you may not write "nothing needs your attention"/)
  })

  it('leaves an ordinary chat turn to the live read tools', () => {
    // A chat turn is answering a question asked right now; the tools are the
    // right source and the attention block would just be stale context.
    const p = prompt({ origin: 'chat', attentionContext: ATTENTION })
    expect(p).not.toContain('WHAT YOU HAVE ALREADY TOLD THEM')
  })

  it('degrades cleanly when no attention state is available', () => {
    const p = prompt({ origin: 'scan' })
    expect(p).toContain('THIS TURN IS A PROACTIVE SCAN')
    expect(p).not.toContain('WHAT YOU HAVE ALREADY TOLD THEM')
  })
})

describe('back-office prompt — high-risk confirmation flow', () => {
  // The audit that found this: send-reply.ts, confirm-pending-action.ts, and
  // _booking-helpers.ts all tell the model to confirm a staged action by
  // calling confirm_pending_action with the pending_action_id, and warn
  // explicitly against re-calling the original tool ("stranded real sends"
  // twice in production — Karenda 2026-08-01, Lamar 2026-08-08). The system
  // prompt used to contradict every one of those tool descriptions by
  // telling the model to "call the SAME tool again with the EXACT SAME
  // arguments" — the exact fragile path the tool authors built
  // confirm_pending_action to replace. This locks the fix in.

  it('tells Caye to confirm via confirm_pending_action, not by re-calling the original tool', () => {
    const p = prompt()
    expect(p).toMatch(/CALL confirm_pending_action WITH THE pending_action_id/)
    expect(p).toMatch(/NEVER the original tool again/)
    expect(p).not.toMatch(/call the SAME tool again with the EXACT SAME arguments/)
  })

  it('explains why re-calling the original tool is unsafe', () => {
    const p = prompt()
    expect(p).toMatch(/byte-identical to what was staged/)
    expect(p).toMatch(/stranded real sends/)
  })

  it('still sends a revision through the original tool, not confirm_pending_action', () => {
    // A correction ("add safe travels to it") is a NEW draft, not an
    // approval of the old one — that has to stage fresh, so it still goes
    // through the original tool.
    const p = prompt()
    expect(p).toMatch(/call the original tool again with the corrected arguments/)
  })

  it('treats a factual confirmation as distinct from send authorization', () => {
    // Requirement 6 (owner-communication policy): confirming a fact used in
    // a draft ("yep $398 is correct") is not the same as approving the send.
    // Caye should ack the fact in one line and wait for the actual send word
    // — never re-paste the full draft, never call confirm_pending_action off
    // a fact-only reply.
    const p = prompt()
    expect(p).toMatch(/A FACTUAL CONFIRMATION IS NOT A SEND AUTHORIZATION/)
    expect(p).toMatch(/Ready to send\./)
    expect(p).toMatch(/Wait for the actual send word/)
  })

  it('keeps the re-surfaced draft short on a non-confirmation reply', () => {
    const p = prompt()
    expect(p).toMatch(/re-surface the staged draft in ONE short clause/)
    expect(p).toMatch(/never the full draft again/)
  })
})

describe('back-office prompt — composing a draft vs. filing an external one (2026-08-17 Pam Ott incident)', () => {
  // Mrs. Max asked "draft please" three times on a customer thread that
  // happened to be email. The first two "draft please"s correctly produced
  // an inline WhatsApp draft; the next two silently filed a Gmail/Zoho
  // draft instead and told her to go open her email. Requirements A, B, C.

  it('says the bare word "draft" always means compose and show inline, regardless of the customer channel', () => {
    const p = prompt()
    expect(p).toMatch(/COMPOSING A DRAFT VS\. FILING AN EXTERNAL ONE/)
    expect(p).toMatch(/WORD "DRAFT" ALONE DOES NOT MEAN THIS TOOL|is NEVER enough on its own to justify it/)
    expect(p).toMatch(/no matter what channel the CUSTOMER is on/)
  })

  it('requires an explicit request before filing into the external email drafts folder', () => {
    const p = prompt()
    expect(p).toMatch(/EXPLICITLY asks for that outcome/)
    expect(p).toMatch(/put this in my email drafts/)
  })

  it('tells Caye to ask in plain language rather than guess when it is unclear', () => {
    const p = prompt()
    expect(p).toMatch(/Want me to send it, or put it in your email drafts/)
    expect(p).toMatch(/never guess/)
  })

  it('lists draft_in_inbox among the HIGH-RISK tools, not the autonomous low-risk ones', () => {
    const backOffice = TOOL_REGISTRY.filter((t) => t.modes.includes('back-office'))
    const draftTool = backOffice.find((t) => t.name === 'draft_in_inbox')
    expect(draftTool?.risk).toBe('high')
    const p = prompt()
    // autonomyBlock() derives its HIGH-RISK list straight from the registry,
    // so this also locks in that draft_in_inbox appears there and NOT in
    // the "execute immediately, no confirmation" low-risk sentence.
    const highRiskLine = p.split('\n').find((l) => l.includes('HIGH-RISK WRITES'))
    expect(highRiskLine).toContain('draft_in_inbox')
    const lowRiskLine = p.split('\n').find((l) => l.includes('LOW-RISK WRITES'))
    expect(lowRiskLine).not.toContain('draft_in_inbox')
  })
})

describe('back-office prompt — internal tool names never reach the operator (2026-08-17 Pam Ott incident)', () => {
  // The real leaked sentence: "should I stage it as a send_reply?"

  it('explicitly bans saying a snake_case tool name out loud', () => {
    const p = prompt()
    expect(p).toMatch(/never say "send_reply", "draft_in_inbox", "confirm_pending_action"/)
    expect(p).toMatch(/describe the OUTCOME each one produces/)
  })

  it('gives the corrected phrasing for the exact real leaked question', () => {
    const p = prompt()
    expect(p).toMatch(/want me to send it, or put it in your email drafts\?/i)
  })
})

describe('back-office prompt — customer-target correction (regression, real Pam Ott incident)', () => {
  // Mid-draft, Mrs. Max said "actually i want it for pam" — a correction of
  // WHO the draft is for, not a new topic. Production correctly re-targeted
  // onto Pam via a fresh search_threads/get_customer lookup and never
  // touched the prior customer's (Sonja's) thread. This is pre-existing
  // prompt behavior (unchanged by this fix); locked in here as a named
  // regression so it can't silently drift while draft_in_inbox is reworked.
  it('requires a tool lookup before naming a specific customer, never a guess from memory', () => {
    const p = prompt()
    expect(p).toMatch(/do NOT fill in the name/)
    expect(p).toMatch(/call search_threads \/ get_customer \/ get_recent_activity \/ get_held_queue/)
  })
})

describe('back-office prompt — current-channel continuity', () => {
  it('says Caye\'s own reply always returns through the channel the operator is on', () => {
    const p = prompt()
    expect(p).toMatch(/your OWN reply always comes back through the channel/)
    expect(p).toMatch(/Never conclude a turn by telling .* to go open/)
  })
})

describe('back-office prompt — CAY-140 operator-communication policy', () => {
  it('tells Caye to lead a revision reply with the new artifact, not a fresh explanation', () => {
    const p = prompt()
    expect(p).toMatch(/YOUR REPLY ON A REVISION IS THE NEW DRAFT, NOT A NEW EXPLANATION/)
    expect(p).toMatch(/one lead word \("Updated:"\)/)
    expect(p).toMatch(/nothing about backend state, nothing re-explaining why an earlier attempt failed/)
  })

  it('caps a disambiguation question to the distinguishing detail, no essay', () => {
    const p = prompt()
    expect(p).toMatch(/give ONLY what's needed to tell the matches apart/)
    expect(p).toMatch(/Jeff Dworkin — North Bimini Historical Tour/)
    expect(p).toMatch(/Jeff A Montenaro — Golf Cart Guided Tour/)
    expect(p).toMatch(/No essay recapping each thread/)
  })

  it('forbids fake progress narration once a tool result has already reported the outcome', () => {
    const p = prompt()
    expect(p).toMatch(/WHEN SOMETHING FAILS — SAY SO PLAINLY, ONCE, WITH NOTHING YOU DON'T KNOW/)
    expect(p).toMatch(/Never say "still on it", "one sec", "still working on it", or "still trying"/)
  })

  it('forbids inventing a root cause for a failure', () => {
    const p = prompt()
    expect(p).toMatch(/Never invent a cause/)
    expect(p).toMatch(/the backend has an issue/i)
    expect(p).toMatch(/the staging system is down/i)
    expect(p).toMatch(/there's a server problem/i)
  })

  it('forbids claiming or suggesting a TropiTech/engineering escalation that never happened', () => {
    const p = prompt()
    expect(p).toMatch(/Never say you flagged, reported, notified, or escalated something to TropiTech/)
    expect(p).toMatch(/worth flagging to the TropiTech team/)
    expect(p).toMatch(/there is no such queue on the other end of that sentence/)
  })

  it('distinguishes a real operator/teammate notification from the banned platform-escalation claim (#141 review)', () => {
    // The prompt originally banned saying you notified "the team" at all —
    // but send_operator_message genuinely can reach another operator on the
    // workspace, so that ban was itself false. It must be scoped to the
    // TropiTech/engineering/support side only.
    const p = prompt()
    expect(p).toMatch(/send_operator_message genuinely can reach a teammate/)
    expect(p).toMatch(/only about the platform\/vendor side/)
  })

  it('gives the exact preserved-draft-failure shape from the regression fixture', () => {
    const p = prompt()
    expect(p).toMatch(/"I couldn't save it to the inbox\. I kept the draft here\." is the complete answer/)
  })
})

describe('morning briefing prompt — no manufactured questions', () => {
  const CLEAR = 'ATTENTION STATE: nothing is open. The owner is genuinely clear.'

  const briefing = (over: Partial<Parameters<typeof buildMorningBriefingPrompt>[0]> = {}) =>
    buildMorningBriefingPrompt({
      operator: 'Mrs. Max',
      business: 'Bimini Island Tours',
      attentionContext: CLEAR,
      ...over,
    })

  it('no longer forces exactly one yes/no question', () => {
    // Requirement 9. This instruction is what produced "Want me to send
    // Ruslan a note asking him to schedule a call with you directly?" on a
    // morning when nothing needed the owner at all.
    const p = briefing()
    expect(p).not.toMatch(/exactly ONE concrete yes\/no question/)
    expect(p).not.toMatch(/close with one light specific offer/)
  })

  it('explicitly permits ending without a question', () => {
    const p = briefing()
    expect(p).toMatch(/A question is not part of the format/)
    expect(p).toMatch(/If nothing needs them, close and stop/)
    expect(p).toMatch(/no invented errand, no question mark/)
    expect(p).toMatch(/A two-sentence briefing is a good briefing/)
  })

  it('tells Caye to act rather than ask when she can act', () => {
    // Requirement 7 again, on the proactive surface.
    const p = briefing()
    expect(p).toMatch(/If you can handle the next step yourself, say you're doing it/)
    expect(p).toMatch(/Not "Want me to chase Jeff\?"/)
  })

  it('forbids inventing work to look interactive', () => {
    expect(briefing()).toMatch(/Never invent work for Mrs\. Max so the message looks interactive/)
  })

  it('still allows a question when a real decision is open', () => {
    const p = briefing()
    expect(p).toMatch(/Ask one ONLY when a real decision is genuinely open/)
  })

  it('keeps the aging-hold offer, which is a real ask about a real item', () => {
    const p = briefing({ oldestAgingHold: { customer: 'Nicole Silvera', daysHeld: 19 } })
    expect(p).toMatch(/Nicole Silvera has been waiting 19 days/)
    expect(p).toMatch(/Want me to take a first pass\?/)
  })

  it('carries the attention state and the no-contradiction rule', () => {
    // Requirement 5, at the composer that produced the contradiction.
    const p = briefing({
      attentionContext:
        'ATTENTION STATE\nThe owner is NOT clear. Do not say "nothing needs your attention" or anything equivalent.',
    })
    expect(p).toContain('WHAT THE OWNER HAS ALREADY BEEN TOLD')
    expect(p).toMatch(/The attention block above is authoritative/)
    expect(p).toMatch(/you may not write "nothing needs your attention"/)
    expect(p).toMatch(/Items listed as resolved are done/)
  })

  it('reports a genuinely clear state as clear', () => {
    expect(briefing()).toContain('nothing is open')
  })
})

describe('EOD summary prompt — compressed recap, no fake all-clear', () => {
  // buildEodSummaryPrompt used to be inlined in composeEodSummary (an async
  // DB+LLM function), so none of its rules had test coverage even though
  // buildMorningBriefingPrompt's identical-in-spirit rules did. Extracted as
  // a pure function so these can be asserted directly.
  const CLEAR = 'ATTENTION STATE: nothing is open. The owner is genuinely clear.'

  const eod = (over: Partial<Parameters<typeof buildEodSummaryPrompt>[0]> = {}) =>
    buildEodSummaryPrompt({
      operator: 'Mrs. Max',
      business: 'Bimini Island Tours',
      attentionContext: CLEAR,
      ...over,
    })

  it('caps the recap at 3 sentences and bans jargon/parentheticals', () => {
    const p = eod()
    expect(p).toMatch(/Hard cap: 3 sentences, no exceptions/)
    expect(p).toMatch(/no jargon, no parentheticals/)
  })

  it('leads with the day\'s outcome, not a status dump', () => {
    const p = eod()
    expect(p).toMatch(/Sentence 1: the day's outcome in one line — wins first/)
    expect(p).toMatch(/Don't dump raw numbers without context/)
  })

  it('does not duplicate the escalation-followup ping', () => {
    // Rule 4/14: routine, already-pinged items don't get re-narrated by a
    // second composer — that's the "wall of near-identical texts" failure.
    const p = eod()
    expect(p).toMatch(/already get their own daily "still waiting" ping from a separate system/)
    expect(p).toMatch(/don't name them or re-propose an action here/)
  })

  it('carries the attention state and forbids a false all-clear', () => {
    const p = eod({
      attentionContext:
        'ATTENTION STATE\nThe owner is NOT clear. Do not say "nothing needs your attention" or anything equivalent.',
    })
    expect(p).toContain('WHAT THE OWNER HAS ALREADY BEEN TOLD')
    expect(p).toMatch(/If it says the owner is not clear, don't write anything that means "all caught up"/)
  })

  it('bans inventing numbers when nothing happened', () => {
    expect(eod()).toMatch(/Don't invent — if nothing happened, say so honestly/)
  })

  it('is informational only — never asks for action', () => {
    expect(eod()).toMatch(/Don't ask for action — this is informational/)
  })
})

/**
 * AUTONOMY REGRESSION GUARD.
 *
 * The read → report / write-low → do it / write-high → stage + recommend
 * model is easy to undo by accident: every new prompt block is a chance to
 * write "would you like me to…" back in. These assert the model survives
 * across every surface that got new instructions, not just the one where it
 * was defined.
 */
describe('autonomy model survives the new prompt blocks', () => {
  const surfaces: Array<[string, string]> = [
    ['back-office chat', prompt()],
    ['back-office scan', prompt({ origin: 'scan', attentionContext: 'ATTENTION STATE: nothing is open.' })],
    [
      'morning briefing',
      buildMorningBriefingPrompt({
        operator: 'Mrs. Max',
        business: 'Bimini Island Tours',
        attentionContext: 'ATTENTION STATE: nothing is open. The owner is genuinely clear.',
      }),
    ],
    [
      'morning briefing (aging hold)',
      buildMorningBriefingPrompt({
        operator: 'Mrs. Max',
        business: 'Bimini Island Tours',
        attentionContext: 'ATTENTION STATE\nThe owner is NOT clear.',
        oldestAgingHold: { customer: 'Nicole Silvera', daysHeld: 19 },
      }),
    ],
  ]

  it.each(surfaces)('%s never instructs Caye to ask permission as a default', (_name, p) => {
    // The only permitted "want me to" in any prompt is an OFFER about a
    // specific stalled item, or an example being explicitly forbidden.
    const lines = p.split('\n').filter((l) => /want me to|would you like me to/i.test(l))
    for (const line of lines) {
      // Permitted shapes, each for a stated reason:
      const isProhibition = /\bNever\b|\bNot "|\bNEVER\b|don't ask|rather than ask/i.test(line)
      // An offer about one specific item that has genuinely stalled.
      const isAgingHoldOffer = /first pass/i.test(line)
      // Recognising a PRIOR Caye message, not instructing a new one. Saving a
      // standing rule really is owner judgment — it governs future behaviour.
      const isRecognisingPastProposal = /candidate_id|CAYE PROPOSING/i.test(line)
      expect(
        isProhibition || isAgingHoldOffer || isRecognisingPastProposal,
        `permission-seeking reintroduced: "${line.trim()}"`
      ).toBe(true)
    }
  })

  it.each(surfaces)('%s never tells Caye to narrate a tool call', (_name, p) => {
    // "Let me check" appears in every prompt — but only inside a ban list.
    const lines = p.split('\n').filter((l) => /Let me check|I'll look into/i.test(l))
    for (const line of lines) {
      expect(
        /NEVER|Never write|ban|Bad:|not\b/i.test(line),
        `narration permitted: "${line.trim()}"`
      ).toBe(true)
    }
  })

  it('the three tiers are still stated as distinct behaviours', () => {
    const p = prompt()
    expect(p).toMatch(/READ tools: never mention them/)
    expect(p).toMatch(/LOW-RISK WRITES execute immediately and need NO permission/)
    expect(p).toMatch(/HIGH-RISK WRITES are gated in code/)
  })

  it('every registered low-risk tool is still covered by the no-ask rule', () => {
    // Derived from TOOL_REGISTRY, so adding a tool without updating prose
    // cannot silently drop it out of the autonomy model.
    const p = prompt()
    const low = TOOL_REGISTRY.filter((t) => t.modes.includes('back-office') && t.risk === 'low')
    expect(low.length).toBeGreaterThan(10)
    for (const t of low) expect(p, t.name).toContain(t.name)
  })

  it('the attention block does not turn awareness items into questions', () => {
    // An awareness item with a question mark becomes a decision, which is how
    // "you're clear" briefings grow errands.
    const p = prompt({
      origin: 'scan',
      attentionContext: 'ATTENTION STATE\n  - Reminder — call the dive shop (priority: awareness)',
    })
    expect(p).toMatch(/NO question mark — a question turns it into a decision/)
  })

  it('the attention context never puts a bracketed enum in front of the model', () => {
    // Priority renders as prose. A model handed "[decision]" can echo it, and
    // that is the shape that reached Mrs. Max as "[operator_reminder]".
    const ctx = renderAttentionContext({
      unreported: [
        {
          id: '1',
          workspaceId: 'ws',
          subjectType: 'conversation',
          subjectId: 'c1',
          conversationId: 'c1',
          title: 'Ruslan — B2B',
          priority: 'decision',
          status: 'open',
          firstNotifiedAt: null,
          lastNotifiedAt: null,
          notifyCount: 0,
          lastNotifiedSummary: null,
          acknowledgedAt: null,
          decidedAt: null,
          decision: null,
          nextAction: 'Waiting on your call',
          completedAt: null,
          stateFingerprint: 'fp',
          notifiedFingerprint: null,
          lastChangedAt: '2026-08-12T09:00:00Z',
          digest: null,
          blockedOnOperator: true,
          resolvableAutonomously: false,
          lastNotificationQueueId: null,
          pendingNotificationQueueId: null,
          operatorAwareFingerprint: null,
          operatorAwareAt: null,
          operatorAwareSummary: null,
          firstStateFingerprint: null,
        },
      ],
      changed: [],
      unchanged: [],
      inFlight: [],
      alreadyKnownToOperator: [],
      resolvedSince: [],
      allClear: false,
    })
    expect(ctx).not.toMatch(/\[decision\]/)
    expect(ctx).toMatch(/\(priority: decision\)/)
    expect(detectInternalLeak(ctx)).toBeNull()
  })
})
