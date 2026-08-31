import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAllCurrentClaims: vi.fn(),
  getLatestBriefs: vi.fn(),
  getResearchStatus: vi.fn(),
}))

vi.mock('@/lib/research/runtime', () => mocks)
vi.mock('server-only', () => ({}))

import { buildStrategicResearchSnapshot } from '../snapshot'

const NOW = new Date('2026-08-31T12:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getAllCurrentClaims.mockResolvedValue([])
  mocks.getLatestBriefs.mockResolvedValue([])
  mocks.getResearchStatus.mockResolvedValue([])
})

describe('strategic research snapshot', () => {
  it('suppresses stale weekly intelligence instead of re-announcing it', async () => {
    mocks.getLatestBriefs.mockResolvedValue([{
      revision: 1,
      created_at: '2026-08-01T00:00:00.000Z',
      material_changes: ['Old change'],
      recommendations: ['Old recommendation'],
      implications: ['Old implication'],
      conflicting_evidence: [], unknowns: [], current_understanding: 'Old understanding',
    }])
    const snapshot = await buildStrategicResearchSnapshot(NOW)
    expect(snapshot.whatChanged).toEqual([])
    expect(snapshot.recommendedNextActions).toEqual([])
    expect(snapshot.whatYouShouldKnow).toEqual([])
  })

  it('surfaces material changes, conflicts, recommendations, and unresolved questions', async () => {
    mocks.getLatestBriefs.mockResolvedValue([{
      revision: 2,
      created_at: '2026-08-30T00:00:00.000Z',
      material_changes: ['Inference costs fell materially'],
      recommendations: ['Benchmark the new routing option'],
      implications: ['Smaller models may now cover routine work'],
      conflicting_evidence: ['Quality on Caye tasks remains unproven'],
      unknowns: ['Representative task benchmark'],
      current_understanding: 'Routing economics improved, but quality still needs evidence.',
    }])
    mocks.getResearchStatus.mockResolvedValue([{
      research_questions: [
        { question: 'Can smaller models preserve quality?', status: 'researching' },
        { question: 'Archived question', status: 'archived' },
      ],
    }])
    const snapshot = await buildStrategicResearchSnapshot(NOW)
    expect(snapshot.whatChanged).toContain('Inference costs fell materially')
    expect(snapshot.threatsAndChangedAssumptions).toContain('Quality on Caye tasks remains unproven')
    expect(snapshot.recommendedNextActions).toContain('Benchmark the new routing option')
    expect(snapshot.stillInvestigating).toEqual(['Can smaller models preserve quality?'])
  })

  it('preserves contested beliefs and strips raw ids from human-facing text', async () => {
    mocks.getAllCurrentClaims.mockResolvedValue([{
      statement: 'Claim 123e4567-e89b-42d3-a456-426614174000',
      confidence: 0.9,
      status: 'contested',
      valid_until: null,
      research_claim_evidence: [{ stance: 'contradicts' }],
    }])
    const snapshot = await buildStrategicResearchSnapshot(NOW)
    expect(snapshot.strongestBeliefs[0].contested).toBe(true)
    expect(snapshot.strongestBeliefs[0].statement).not.toContain('123e4567')
    expect(snapshot.changedMindRecently[0]).toContain('Evidence is contesting')
  })

  it('suppresses repeated unchanged recommendations on later revisions', async () => {
    mocks.getLatestBriefs.mockResolvedValue([{
      revision: 3,
      created_at: '2026-08-30T00:00:00.000Z',
      material_changes: [],
      recommendations: ['Run the benchmark'],
      implications: [], conflicting_evidence: [], unknowns: [], current_understanding: 'No material change.',
    }])
    const snapshot = await buildStrategicResearchSnapshot(NOW)
    expect(snapshot.recommendedNextActions).toEqual([])
    expect(snapshot.whatYouShouldKnow).toEqual([])
  })

  it('allows first-revision recommendations to establish the baseline', async () => {
    mocks.getLatestBriefs.mockResolvedValue([{
      revision: 1,
      created_at: '2026-08-30T00:00:00.000Z',
      material_changes: [],
      recommendations: ['Run the benchmark'],
      implications: [], conflicting_evidence: [], unknowns: [], current_understanding: 'Initial evidence-backed baseline.',
    }])
    const snapshot = await buildStrategicResearchSnapshot(NOW)
    expect(snapshot.recommendedNextActions).toEqual(['Run the benchmark'])
  })
})
