import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
// Telemetry writes to Supabase; the extraction call itself is the thing
// under test, so the log write is stubbed rather than mocked out entirely.
vi.mock('@/lib/llm-telemetry', async () => {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  return {
    loggedMessagesCreate: (
      client: InstanceType<typeof Anthropic>,
      params: Parameters<InstanceType<typeof Anthropic>['messages']['create']>[0]
    ) => client.messages.create(params),
  }
})

import { DIGEST_FIXTURES } from './inbound-digest.fixtures'
import { renderDigestBody, digestClosingAsk, type InboundDigest } from './inbound-digest'

/**
 * LIVE extraction quality, against the real model.
 *
 * The unit tests prove the renderer's shape from a hand-written digest. They
 * cannot tell you whether the extractor actually READS an email correctly —
 * and reading correctly is the entire value of this path. So this runs the
 * real thing over lib/inbound-digest.fixtures.ts.
 *
 * OPT-IN, because it costs tokens and needs a key:
 *   RUN_LLM_TESTS=1 npx vitest run lib/inbound-digest.live.test.ts
 *
 * Assertions are deliberately about JUDGMENT, not wording — whether the ask
 * was found, whether a decision was invented, whether a deadline survived.
 * Asserting exact phrasing against a sampled model is how you get a suite
 * that fails for no reason and gets disabled.
 */

const ENABLED = process.env.RUN_LLM_TESTS === '1' && !!process.env.ANTHROPIC_API_KEY
const d = ENABLED ? describe : describe.skip

d('inbound digest — live extraction over realistic email shapes', () => {
  for (const fx of DIGEST_FIXTURES) {
    it(`${fx.id}: ${fx.about}`, async () => {
      const { extractInboundDigest } = await import('./inbound-digest-extract')
      const digest = await extractInboundDigest({
        body: fx.body,
        contactName: fx.contactName,
        alreadySent: fx.alreadySent,
      })

      expect(digest, 'extraction returned null').not.toBeNull()
      const d = digest as InboundDigest

      // ── The core distinction ───────────────────────────────────────────
      // "contains business information" vs "the owner must act now".
      expect(d.substantive, `substantive should be ${fx.expect.substantive}`).toBe(
        fx.expect.substantive
      )
      expect(
        d.actionNeeded,
        fx.expect.actionNeeded
          ? 'something has to be done here and Caye read it as needing nothing'
          : 'nothing needs doing, but Caye read it as actionable'
      ).toBe(fx.expect.actionNeeded)

      const askedForSomething = digestClosingAsk(d) !== null
      expect(
        askedForSomething,
        fx.expect.decisionExpected
          ? 'a real decision exists but Caye asked for nothing'
          : `Caye invented a decision: ${d.decisionNeeded}`
      ).toBe(fx.expect.decisionExpected)

      // ── Grounding ──────────────────────────────────────────────────────
      for (const field of fx.expect.required ?? []) {
        expect(d[field as keyof InboundDigest], `${field} should be populated`).toBeTruthy()
      }
      for (const field of fx.expect.forbidden ?? []) {
        expect(
          d[field as keyof InboundDigest],
          `${field} was invented — the email does not state it`
        ).toBeNull()
      }

      // ── Did it read the actual ask? ────────────────────────────────────
      const haystack = [d.intent, d.requestedAction, d.whyItMatters].filter(Boolean).join(' ').toLowerCase()
      for (const needle of fx.expect.intentMentions ?? []) {
        expect(haystack, `the ask should mention "${needle}"`).toContain(needle.toLowerCase())
      }

      // ── Never a quote ──────────────────────────────────────────────────
      const rendered = renderDigestBody(d).join('\n')
      for (const banned of fx.expect.neverRendered ?? []) {
        expect(rendered, `pleasantries leaked into the brief: "${banned}"`).not.toContain(banned)
      }
      expect(rendered, 'the sender was quoted rather than summarised').not.toContain('wrote:')
    }, 60_000)
  }
})

/**
 * Shape-level checks that need no network — these run in the normal suite, so
 * the fixture set stays honest even when the live run is skipped.
 */
describe('digest fixtures — the set covers what it claims to', () => {
  it('covers all ten required shapes', () => {
    expect(DIGEST_FIXTURES).toHaveLength(10)
    expect(new Set(DIGEST_FIXTURES.map((f) => f.id)).size).toBe(10)
  })

  it('separates "has content" from "needs action"', () => {
    // The harbour notice is the proof case: real content, nothing to do.
    const notice = DIGEST_FIXTURES.find((f) => f.id === 'purely-informational')
    expect(notice?.expect.substantive).toBe(true)
    expect(notice?.expect.actionNeeded).toBe(false)
  })

  it('never expects a decision where no action is needed', () => {
    for (const f of DIGEST_FIXTURES) {
      if (!f.expect.actionNeeded) {
        expect(f.expect.decisionExpected, `${f.id}`).toBe(false)
      }
    }
  })

  it('includes both non-substantive cases that must never create work', () => {
    // The holding note and the thank-you. These are the two the old path got
    // most wrong: it turned both into "Your call on whether to take this on."
    const quiet = DIGEST_FIXTURES.filter((f) => !f.expect.substantive)
    expect(quiet.map((f) => f.id)).toEqual(
      expect.arrayContaining(['holding-note-after-our-reply', 'pure-thanks'])
    )
    for (const f of quiet) {
      expect(f.expect.decisionExpected, `${f.id} must not expect a decision`).toBe(false)
    }
  })

  it('includes a deadline case that is NOT allowed to be routine', () => {
    const deadline = DIGEST_FIXTURES.find((f) => f.id === 'hard-deadline')
    expect(deadline?.expect.required).toContain('deadline')
    expect(deadline?.expect.substantive).toBe(true)
  })

  it('includes a money case requiring financialImpact', () => {
    const money = DIGEST_FIXTURES.find((f) => f.id === 'money-on-the-table')
    expect(money?.expect.required).toContain('financialImpact')
  })

  it('asserts pleasantries never render on the two Ruslan fixtures', () => {
    for (const id of ['ask-at-the-bottom', 'holding-note-after-our-reply']) {
      const f = DIGEST_FIXTURES.find((x) => x.id === id)
      expect(f?.expect.neverRendered).toContain('Dear Karenda')
    }
  })
})
