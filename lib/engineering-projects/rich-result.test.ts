import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { validateRichResult } from '@/lib/caye-direct-rich-results'
import { engineeringProjectRichResultFromTurns } from './turn-rich-result'
import { propertyRichResultFromTurns } from '@/lib/property/turn-rich-result'

function successfulProjectTurns(projectId = 'project-123'): Anthropic.MessageParam[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'get_engineering_project', input: { project_id: projectId } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '{"ok":true}' }] },
  ]
}

describe('engineering project trusted rich results', () => {
  it('rejects a model-authored engineering project block', () => {
    expect(validateRichResult({ version: 1, narrative: 'project', blocks: [{ type: 'engineering_project', projectId: 'project-123' }] })).toBeNull()
  })

  it('derives a project card only from a successful get_engineering_project execution', () => {
    expect(engineeringProjectRichResultFromTurns(successfulProjectTurns())).toEqual({ version: 1, narrative: '', blocks: [{ type: 'engineering_project', projectId: 'project-123' }] })
  })

  it('does not render a project card when the matching tool result failed', () => {
    const turns: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'get_engineering_project', input: { project_id: 'project-123' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'failed', is_error: true }] },
    ]
    expect(engineeringProjectRichResultFromTurns(turns)).toBeUndefined()
  })

  it('merges property and project trusted cards through the existing Direct hook', () => {
    const turns: Anthropic.MessageParam[] = [
      ...successfulProjectTurns(),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'get_property_snapshot', input: { property_id: 'property-123' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: '{"ok":true}' }] },
    ]
    expect(propertyRichResultFromTurns(turns)?.blocks).toEqual([
      { type: 'property_snapshot', propertyId: 'property-123' },
      { type: 'engineering_project', projectId: 'project-123' },
    ])
  })
})
