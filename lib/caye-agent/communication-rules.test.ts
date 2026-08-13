import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { buildBackOfficeSystemPrompt } from './modes/back-office'
import { buildMorningBriefingPrompt } from './briefing'
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
        },
      ],
      changed: [],
      unchanged: [],
      inFlight: [],
      resolvedSince: [],
      allClear: false,
    })
    expect(ctx).not.toMatch(/\[decision\]/)
    expect(ctx).toMatch(/\(priority: decision\)/)
    expect(detectInternalLeak(ctx)).toBeNull()
  })
})
