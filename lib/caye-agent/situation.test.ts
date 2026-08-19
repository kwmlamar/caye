import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  relativeTimeLabel,
  annotateHistoryWithRelativeTime,
  renderSituationForPrompt,
  todaysDateLabel,
  type CayeSituation,
} from './situation'

describe('relativeTimeLabel', () => {
  const now = '2026-08-16T12:00:00.000Z'

  it('labels sub-90-second gaps as "just now"', () => {
    expect(relativeTimeLabel('2026-08-16T11:59:30.000Z', now)).toBe('just now')
  })

  it('labels minutes correctly', () => {
    expect(relativeTimeLabel('2026-08-16T11:57:00.000Z', now)).toBe('3 minutes ago')
  })

  it('labels an hour-scale gap', () => {
    expect(relativeTimeLabel('2026-08-16T10:30:00.000Z', now)).toBe('about an hour ago')
  })

  it('labels multi-hour gaps in hours', () => {
    expect(relativeTimeLabel('2026-08-16T06:00:00.000Z', now)).toBe('6 hours ago')
  })

  it('labels a gap in the 24-48h band as "yesterday"', () => {
    expect(relativeTimeLabel('2026-08-15T06:00:00.000Z', now)).toBe('yesterday')
  })

  it('labels multi-day gaps in days', () => {
    expect(relativeTimeLabel('2026-08-12T12:00:00.000Z', now)).toBe('4 days ago')
  })

  it('falls back to an absolute date beyond a week', () => {
    expect(relativeTimeLabel('2026-08-01T12:00:00.000Z', now)).toBe('on Aug 1')
  })
})

describe('annotateHistoryWithRelativeTime', () => {
  const now = '2026-08-16T12:00:00.000Z'

  it('prefixes plain-string user turns with a bracket-free relative-time marker', () => {
    const out = annotateHistoryWithRelativeTime(
      [{ role: 'user', content: 'just paid and got my receipt!' }],
      ['2026-08-16T11:57:00.000Z'],
      now
    )
    expect(out[0].content).toBe('3 minutes ago — just paid and got my receipt!')
    // No bracket-wrapped internal token — see lib/no-internal-leak-paths.test.ts.
    expect(out[0].content).not.toMatch(/\[.*\]/)
  })

  it('leaves assistant turns untouched', () => {
    const out = annotateHistoryWithRelativeTime(
      [{ role: 'assistant', content: 'Your spot is held for Saturday.' }],
      ['2026-08-16T11:57:00.000Z'],
      now
    )
    expect(out[0].content).toBe('Your spot is held for Saturday.')
  })

  it('leaves array-content turns (tool_use/tool_result) untouched — documented scope limit', () => {
    const arrayContent = [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }]
    const out = annotateHistoryWithRelativeTime(
      [{ role: 'user', content: arrayContent as never }],
      ['2026-08-16T11:57:00.000Z'],
      now
    )
    expect(out[0].content).toBe(arrayContent)
  })

  it('leaves a turn with no known timestamp unannotated', () => {
    const out = annotateHistoryWithRelativeTime([{ role: 'user', content: 'hello' }], [null], now)
    expect(out[0].content).toBe('hello')
  })

  it('does not mutate the input array', () => {
    const input = [{ role: 'user' as const, content: 'hi' }]
    annotateHistoryWithRelativeTime(input, ['2026-08-16T11:57:00.000Z'], now)
    expect(input[0].content).toBe('hi')
  })
})

describe('todaysDateLabel (2026-08-16, final pre-canary closure — the Scenario C date-resolution defect)', () => {
  it('renders both the ISO date and a spelled-out weekday/month/day/year form', () => {
    const label = todaysDateLabel('2026-08-16T12:00:00.000Z', 'UTC')
    expect(label).toContain('2026-08-16')
    expect(label).toContain('Sunday, August 16, 2026')
  })

  it('instructs resolving relative/partial dates against this anchor, not memory', () => {
    const label = todaysDateLabel('2026-08-16T12:00:00.000Z', 'UTC')
    expect(label).toMatch(/relative to this, not from memory or assumption/i)
  })

  it('is stable across different times of day on the same date in the given timezone', () => {
    expect(todaysDateLabel('2026-08-16T00:00:01.000Z', 'UTC')).toContain('2026-08-16')
    expect(todaysDateLabel('2026-08-16T23:59:59.000Z', 'UTC')).toContain('2026-08-16')
  })

  it('returns empty string for an invalid date rather than throwing', () => {
    expect(todaysDateLabel('not-a-date', 'UTC')).toBe('')
  })

  it('correctly resolves a year boundary — the exact class of mistake this closes', () => {
    // The real defect: "Friday, November 20" was resolved to 2025 when the
    // actual runtime date was 2026-08-16. A model with THIS label present
    // has the correct year stated outright, not left to infer.
    const label = todaysDateLabel('2026-08-16T12:00:00.000Z', 'UTC')
    expect(label).toContain('2026')
    expect(label).not.toContain('2025')
  })

  // CAY-95 regression: the front-desk anchor used to format in UTC
  // regardless of the workspace's real timezone. The same instant must
  // resolve to a different calendar date for a workspace ahead of UTC vs.
  // one behind it — proving this is business-local, not UTC-naive.
  it('resolves the anchor date in the workspace timezone, not UTC — same instant, different workspaces', () => {
    const now = '2026-06-01T23:30:00.000Z'
    expect(todaysDateLabel(now, 'Pacific/Auckland')).toContain('2026-06-02')
    expect(todaysDateLabel(now, 'Pacific/Honolulu')).toContain('2026-06-01')
  })
})

describe('renderSituationForPrompt', () => {
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

  it('renders only the date anchor, and does not throw, when there is no background state', () => {
    expect(() => renderSituationForPrompt(baseSituation)).not.toThrow()
    expect(renderSituationForPrompt(baseSituation)).toBe(todaysDateLabel(baseSituation.now, baseSituation.timezone))
  })

  it('renders relationship state as read-only background, never as an authorization', () => {
    const situation: CayeSituation = {
      ...baseSituation,
      relationship: {
        relationshipId: 'rel_1',
        contactId: 'contact_1',
        state: 'engaged',
        meaningfulInteractionStartedAt: '2026-08-01T12:00:00.000Z',
        lastMeaningfulInteractionAt: '2026-08-16T11:57:00.000Z',
      },
    }
    const block = renderSituationForPrompt(situation)
    expect(block).toContain('RELATIONSHIP STATE (read-only background, not an authorization): engaged')
    expect(block).toContain('3 minutes ago')
  })

  it('renders open work opportunities as background only, never as an instruction', () => {
    const situation: CayeSituation = {
      ...baseSituation,
      workOpportunities: [
        {
          id: 'op_1',
          opportunityType: 'inbox_help_needed',
          description: 'Prospect mentioned drowning in email.',
          status: 'observed',
          confidence: 'high',
          lastEvidencedAt: '2026-08-16T11:00:00.000Z',
        },
      ],
    }
    const block = renderSituationForPrompt(situation)
    expect(block).toContain('OPEN WORK OBSERVED FOR THIS RELATIONSHIP')
    expect(block).toContain('not an instruction to act on any of them')
    expect(block).toContain('Prospect mentioned drowning in email.')
  })
})
