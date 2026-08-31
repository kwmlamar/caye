import { describe, expect, it } from 'vitest'
import { graphPriorityQuestions } from './intelligence-priorities'

const desk = {
  id: 'desk-ai',
  key: 'ai-global-technology',
  programId: 'program-ai',
  domain: 'ai',
  standingMission: 'Track material AI developments.',
  standingQuestions: ['What changed in frontier models?'],
} as any

describe('graphPriorityQuestions', () => {
  it('routes only matching-domain unresolved graph state into the desk', () => {
    const questions = graphPriorityQuestions({
      desk,
      recentQuestions: [],
      limit: 3,
      priorities: [
        { kind: 'contradiction', statement: 'Resolve contradiction: model costs fell ↔ quality regressed', confidence: 0.7, materiality: 0.9, observedAt: null, domains: ['ai', 'markets'] },
        { kind: 'stale_high_materiality', statement: 'Refresh evidence for: hiring demand changed', confidence: 0.6, materiality: 0.8, observedAt: null, domains: ['career'] },
      ],
    })

    expect(questions).toEqual([{
      question: 'Resolve contradiction: model costs fell ↔ quality regressed',
      mode: 'monitoring',
      depth: 0,
    }])
  })

  it('does not requeue a graph question already researched in the current desk window', () => {
    const questions = graphPriorityQuestions({
      desk,
      recentQuestions: ['Resolve contradiction: model costs fell ↔ quality regressed'],
      limit: 3,
      priorities: [
        { kind: 'contradiction', statement: 'Resolve contradiction: model costs fell ↔ quality regressed', confidence: 0.7, materiality: 0.9, observedAt: null, domains: ['ai'] },
      ],
    })
    expect(questions).toEqual([])
  })
})
