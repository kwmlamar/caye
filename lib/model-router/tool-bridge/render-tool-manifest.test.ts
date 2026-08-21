import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { renderToolManifest } from './render-tool-manifest'
import type { Tool } from '@/lib/caye-agent/tools/types'

const fakeTool: Tool<{ query: string }> = {
  name: 'get_customer',
  description: 'Look up a customer by name.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  async execute() {
    return { ok: true, data: {} }
  },
}

describe('renderToolManifest', () => {
  it('renders name, description, and input schema for each tool', () => {
    const out = renderToolManifest([fakeTool])
    expect(out).toContain('get_customer')
    expect(out).toContain('Look up a customer by name.')
    expect(out).toContain('"query"')
  })

  it('renders a clear message for an empty tool list', () => {
    expect(renderToolManifest([])).toBe('No tools are available for this turn.')
  })
})
