import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { findTool } from '@/lib/caye-agent/tools/registry'

const names = [
  'list_engineering_projects',
  'get_engineering_project',
  'compare_engineering_project_outcomes',
  'create_engineering_project',
  'establish_engineering_baseline',
  'add_engineering_alternative',
  'select_engineering_alternative',
  'record_engineering_execution',
  'link_engineering_outcome',
  'record_engineering_verdict',
]

describe('CAY-26 project tool registration', () => {
  it.each(names)('%s is founder-only and back-office', (name) => {
    const tool = findTool(name)
    expect(tool?.roles).toEqual(['founder'])
    expect(tool?.modes).toEqual(['back-office'])
  })

  it('keeps reads read-only and persistence writes low-risk', () => {
    expect(findTool('list_engineering_projects')?.risk).toBe('read')
    expect(findTool('get_engineering_project')?.risk).toBe('read')
    expect(findTool('compare_engineering_project_outcomes')?.risk).toBe('read')
    for (const name of names.filter((n) => !['list_engineering_projects','get_engineering_project','compare_engineering_project_outcomes'].includes(n))) {
      expect(findTool(name)?.risk).toBe('low')
    }
  })
})
