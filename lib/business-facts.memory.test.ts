import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./supabase-server', () => ({ createServiceClient: vi.fn() }))

const { formatBusinessFactsBlock } = await import('./business-facts')

describe('business fact memory prompt boundaries', () => {
  it('renders service scope as a hard do-not-generalize boundary', () => {
    const block = formatBusinessFactsBlock([
      {
        id: 'm1',
        category: 'logistics',
        fact: 'Guests meet at the Casino Tram Stop.',
        memoryType: 'correction',
        knowledgeMode: 'explicit',
        confidence: 0.98,
        subjectType: 'service',
        subjectId: 'svc-heritage',
      },
    ])

    expect(block).toContain('[scope: service svc-heritage; do not generalize]')
    expect(block).toContain('A scope label is a hard boundary')
  })

  it('does not add a scope warning to workspace-wide memory', () => {
    const block = formatBusinessFactsBlock([
      {
        id: 'm1',
        category: 'policy',
        fact: 'Cash is not accepted.',
        subjectType: 'workspace',
        subjectId: null,
      },
    ])

    expect(block).toContain('- Cash is not accepted.')
    expect(block).not.toContain('[scope: workspace')
  })

  it('marks inferred memory as context rather than policy', () => {
    const block = formatBusinessFactsBlock([
      {
        id: 'm1',
        category: 'service_detail',
        fact: 'Guests often arrive early.',
        knowledgeMode: 'inferred',
        subjectType: 'workspace',
        subjectId: null,
      },
    ])

    expect(block).toContain('[observed pattern, not policy]')
  })
})
