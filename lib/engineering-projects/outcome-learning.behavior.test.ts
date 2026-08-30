import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const addEngineeringAlternative = vi.fn()
const getEngineeringOutcomeLearningGuidance = vi.fn()

vi.mock('./store', () => ({
  addEngineeringAlternative,
  compareEngineeringProjectOutcomes: vi.fn(),
  createEngineeringProject: vi.fn(),
  establishEngineeringBaseline: vi.fn(),
  getEngineeringProjectSnapshot: vi.fn(),
  linkEngineeringOutcome: vi.fn(),
  listEngineeringProjects: vi.fn(),
  recordEngineeringExecutionEvidence: vi.fn(),
  recordEngineeringVerdict: vi.fn(),
  selectEngineeringAlternative: vi.fn(),
}))

vi.mock('./outcome-learning', () => ({
  getEngineeringOutcomeLearningGuidance,
  processEngineeringOutcomeLearning: vi.fn(),
}))

const { addEngineeringAlternativeTool } = await import('./tools')

const ctx = {
  workspaceId: 'workspace-a',
  channel: 'dashboard' as const,
  mode: 'back-office' as const,
  role: 'founder' as const,
}

const args = {
  project_id: 'project-later',
  alternative_key: 'tank-change',
  title: 'Tank change',
  description: 'Test a revised tank setup.',
  predictions: [{ metric_key: 'tank_refill_days', numeric_value: 10, unit: 'days', provenance_status: 'estimated' as const }],
}

describe('outcome learning changes later engineering guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addEngineeringAlternative.mockResolvedValue({ id: 'alt-1' })
  })

  it('has no learned guidance before a lesson is validated', async () => {
    getEngineeringOutcomeLearningGuidance.mockResolvedValue([])
    const result = await addEngineeringAlternativeTool.execute(args, ctx as never)
    expect(result.ok).toBe(true)
    expect((result as { data: { learning_guidance: unknown[] } }).data.learning_guidance).toEqual([])
  })

  it('surfaces a validated lesson on a later inferred/estimated prediction without rewriting the prediction', async () => {
    getEngineeringOutcomeLearningGuidance.mockResolvedValue([{
      metricKey: 'tank_refill_days',
      unit: 'days',
      direction: 'underpredicted',
      confidence: 0.85,
      evidenceCount: 2,
      memoryId: 'memory-1',
      recommendation: 'Verified outcomes across 2 engineering projects show estimated refill-day predictions have tended to land below actual results. Treat this as guidance, not policy.',
    }])

    const result = await addEngineeringAlternativeTool.execute(args, ctx as never)
    expect(result.ok).toBe(true)
    const data = (result as { data: { learning_guidance: Array<{ memoryId: string }>; alternative: { id: string } } }).data
    expect(data.learning_guidance).toHaveLength(1)
    expect(data.learning_guidance[0].memoryId).toBe('memory-1')
    expect(addEngineeringAlternative).toHaveBeenCalledWith(expect.objectContaining({
      predictions: [expect.objectContaining({ numericValue: 10, provenanceStatus: 'estimated' })],
    }))
  })

  it('does not apply inferred outcome guidance to operator-confirmed predictions', async () => {
    getEngineeringOutcomeLearningGuidance.mockResolvedValue([])
    const confirmedArgs = { ...args, predictions: [{ ...args.predictions[0], provenance_status: 'operator_confirmed' as const }] }
    const result = await addEngineeringAlternativeTool.execute(confirmedArgs, ctx as never)
    expect(result.ok).toBe(true)
    expect(getEngineeringOutcomeLearningGuidance).toHaveBeenCalledWith('workspace-a', [expect.objectContaining({ provenanceStatus: 'operator_confirmed' })])
    expect((result as { data: { learning_guidance: unknown[] } }).data.learning_guidance).toEqual([])
  })
})
