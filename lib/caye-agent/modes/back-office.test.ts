import { describe, it, expect, vi } from 'vitest'

// Neutralize the 'server-only' guard so vitest (node env) can load the
// module under test — same shim as execute.test.ts.
vi.mock('server-only', () => ({}))

import { buildBackOfficeSystemPrompt } from './back-office'

/**
 * Regression cover for the 2026-08-06 "Caye doesn't know who she's talking
 * to" bug. Two distinct defects fed the same symptom:
 *
 *  1. The prompt discarded operator_allowlist.name for every non-founder
 *     caller and substituted customers.full_name, so a second owner or any
 *     staff member got addressed as the full_name holder.
 *  2. The scan crons passed callerRole 'founder' while delivering to the
 *     owner, so Caye wrote third-person reports ABOUT the recipient and
 *     sent them TO her ("Worth checking with Mrs. Max" → to Mrs. Max).
 */

// Bimini's real shape: full_name is the primary owner, and the allowlist
// carries two owners plus the founder.
const BIMINI = {
  operatorName: 'Mrs. Max',
  businessName: 'Bimini Island Tours',
}

describe('buildBackOfficeSystemPrompt — caller identity', () => {
  it('addresses the primary owner by name', () => {
    const prompt = buildBackOfficeSystemPrompt({
      profile: BIMINI,
      caller: { role: 'owner', name: 'Mrs. Max' },
    })
    expect(prompt).toContain('Mrs. Max — an owner of the business — is the person')
    // Same person as full_name, so no "different person" disambiguation.
    expect(prompt).not.toContain('is a different person')
  })

  it('does not address a second owner by the full_name holder name', () => {
    const prompt = buildBackOfficeSystemPrompt({
      profile: BIMINI,
      caller: { role: 'owner', name: 'Max' },
    })
    expect(prompt).toContain('Max — an owner of the business — is the person')
    expect(prompt).toContain('The business OWNER on file is Mrs. Max. Max is a different person')
    expect(prompt).not.toContain('Mrs. Max — an owner of the business — is the person')
  })

  it('identifies a staff caller as staff, not as the owner', () => {
    const prompt = buildBackOfficeSystemPrompt({
      profile: BIMINI,
      caller: { role: 'staff', name: 'Sara' },
    })
    expect(prompt).toContain('Sara — a staff member')
    expect(prompt).toContain('Sara is staff, not an owner')
    expect(prompt).toContain("needs Mrs. Max's sign-off")
    // Tool instructions must speak to Sara, not to the owner.
    expect(prompt).toContain("waiting on Sara's approval")
  })

  it('keeps the founder distinct from the workspace owner', () => {
    const prompt = buildBackOfficeSystemPrompt({
      profile: BIMINI,
      caller: { role: 'founder', name: 'Lamar' },
    })
    expect(prompt).toContain('Lamar — the TropiTech founder')
    expect(prompt).toContain('Lamar is a different person')
    expect(prompt).toContain('full operator powers on this workspace via founder role')
  })

  it('falls back to full_name for a nameless legacy owner row', () => {
    const prompt = buildBackOfficeSystemPrompt({
      profile: BIMINI,
      caller: { role: 'owner', name: null },
    })
    expect(prompt).toContain('Mrs. Max — an owner of the business — is the person')
    expect(prompt).not.toContain('is a different person')
  })

  it('bans third-person reference to the person being addressed', () => {
    const prompt = buildBackOfficeSystemPrompt({
      profile: BIMINI,
      caller: { role: 'owner', name: 'Mrs. Max' },
    })
    expect(prompt).toContain('NEVER write about Mrs. Max in the third person')
    expect(prompt).toContain('Never refer to Mrs. Max in the third person')
  })
})

describe('buildBackOfficeSystemPrompt — scan origin', () => {
  it('tells Caye a scan goes to the caller unprompted, in second person', () => {
    const prompt = buildBackOfficeSystemPrompt({
      profile: BIMINI,
      caller: { role: 'owner', name: 'Mrs. Max' },
      origin: 'scan',
    })
    expect(prompt).toContain('THIS TURN IS A PROACTIVE SCAN')
    expect(prompt).toContain("goes straight to Mrs. Max's WhatsApp unprompted")
    expect(prompt).toContain('Mrs. Max is the only reader')
    expect(prompt).toContain('Silence is a valid scan result')
  })

  it('omits the scan block for ordinary chat', () => {
    const prompt = buildBackOfficeSystemPrompt({
      profile: BIMINI,
      caller: { role: 'owner', name: 'Mrs. Max' },
      origin: 'chat',
    })
    expect(prompt).not.toContain('THIS TURN IS A PROACTIVE SCAN')
  })
})

/**
 * Regression cover for 2026-08-07: query_business_knowledge is registered
 * for back-office mode and technically always sent to Claude regardless of
 * prompt wording, but it was the one read tool never called out in the
 * "WHAT YOU CAN DO RIGHT NOW" list — every other read tool gets an explicit
 * "use when X" trigger line, and add_business_fact (the SAVE direction) was
 * documented while the LOOKUP direction never was. Confirmed live: back-
 * office Caye had no prompted reason to check a captured fact (e.g. a
 * mobility-accommodation policy) before answering a capability question.
 */
describe('buildBackOfficeSystemPrompt — business knowledge retrieval', () => {
  it('instructs Caye to look up captured facts before answering a capability question', () => {
    const prompt = buildBackOfficeSystemPrompt({
      profile: BIMINI,
      caller: { role: 'owner', name: 'Mrs. Max' },
    })
    expect(prompt).toContain('query_business_knowledge')
    expect(prompt).toMatch(/before (you )?tell.*(can or can't do|what.*will or won't do)/i)
  })
})
