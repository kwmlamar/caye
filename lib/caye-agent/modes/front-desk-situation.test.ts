import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { buildFrontDeskSituationSystemPrompt } from './front-desk-situation'
import type { CayeSituation } from '../situation'

const baseSituation: CayeSituation = {
  channel: 'front-desk',
  workspaceId: 'ws_1',
  timezone: 'America/Nassau',
  now: '2026-08-16T12:00:00.000Z',
  history: [],
  historyTimestamps: [],
  historyForModel: [],
  relationship: null,
  workOpportunities: [],
  operational: { standingRules: [], businessFacts: [], attentionDelta: null },
}

describe('buildFrontDeskSituationSystemPrompt', () => {
  it('describes the actual bracket-free relative-time format, not the retired bracketed one', () => {
    const prompt = buildFrontDeskSituationSystemPrompt({
      businessName: 'Bimini Island Tours',
      channel: 'whatsapp',
      situation: baseSituation,
    })
    expect(prompt).toContain('3 minutes ago — ...')
    expect(prompt).not.toContain('[3 minutes ago]')
  })

  it('omits the grounding paragraph when no tools are offered', () => {
    const prompt = buildFrontDeskSituationSystemPrompt({
      businessName: 'Bimini Island Tours',
      channel: 'whatsapp',
      situation: baseSituation,
    })
    expect(prompt).not.toContain('GROUNDING')
  })

  it('adds the grounding paragraph when toolsOffered is true', () => {
    const prompt = buildFrontDeskSituationSystemPrompt({
      businessName: 'Bimini Island Tours',
      channel: 'whatsapp',
      situation: baseSituation,
      toolsOffered: true,
    })
    expect(prompt).toContain('GROUNDING')
    expect(prompt).toContain('Never state a price, an availability verdict, or an existing-booking detail')
  })
})
