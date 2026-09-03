import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const addEngineeringAlternative = vi.fn()
const recordEngineeringVerdict = vi.fn()
const getEngineeringOutcomeLearningGuidance = vi.fn()
const processEngineeringOutcomeLearning = vi.fn()

vi.mock('./store', () => ({
  addEngineeringAlternative,
  compareEngineeringProjectOutcomes: vi.fn(),
  createEngineeringProject: vi.fn(),
  establishEngineeringBaseline: vi.fn(),
  getEngineeringProjectSnapshot: vi.fn(),
  linkEngineeringOutcome: vi.fn(),
  listEngineeringProjects: vi.fn(),
  recordEngineeringExecutionEvidence: vi.fn(),
  recordEngineeringVerdict,
  selectEngineeringAlternative: vi.fn(),
}))

vi.mock('./outcome-learning', () => ({
  getEngineeringOutcomeLearningGuidance,
  processEngineeringOutcomeLearning,
}))

const { addEngineeringAlternativeTool, recordEngineeringVerdictTool } = await import('./tools')

const ctx = {
  workspaceId: 'workspace-a',
  channel: 'dashboard' as const,
  mode: 'back-office' as const,
  role: 'founder' as const,
  engineeringOrigin: { messageId: 'message-founder-1' },
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
    recordEngineeringVerdict.mockResolvedValue({ id: 'verdict-1', verdict: 'succeeded' })
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

  it('does not misreport a persisted verdict as failed when the learning follow-up fails', async () => {
    processEngineeringOutcomeLearning.mockRejectedValue(new Error('audit unavailable'))
    const result = await recordEngineeringVerdictTool.execute({ project_id: 'project-1', verdict: 'succeeded', summary: 'Outcome verified.' }, ctx as never)
    expect(result.ok).toBe(true)
    expect((result as { data: { verdict: { id: string }; learning: { error: string } } }).data.verdict.id).toBe('verdict-1')
    expect((result as { data: { learning: { error: string } } }).data.learning.error).toBe('audit unavailable')
  })
})
