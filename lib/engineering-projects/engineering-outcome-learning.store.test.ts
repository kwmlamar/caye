import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(path.resolve(process.cwd(), 'lib/engineering-projects/store.ts'), 'utf8')

describe('engineering learned outcome snapshot wiring', () => {
  it('retrieves learned outcomes for the project property and returns them in the canonical snapshot', () => {
    expect(source).toContain("supabase.rpc('retrieve_engineering_outcome_memory'")
    expect(source).toContain('p_workspace_id: workspaceId')
    expect(source).toContain('p_property_id: project.property_id')
    expect(source).toContain('learned_outcomes: learnedOutcomesResult.error ? [] : learnedOutcomesResult.data ?? []')
  })

  it('fails migration-safe without breaking existing project reads', () => {
    expect(source).toContain("learning_status: learnedOutcomesResult.error ? 'unavailable' : 'available'")
    expect(source).not.toMatch(/learnedOutcomesResult\.error\) throw new Error/)
  })
})
