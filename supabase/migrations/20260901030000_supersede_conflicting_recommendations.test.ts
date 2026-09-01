import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync('supabase/migrations/20260901030000_supersede_conflicting_recommendations.sql', 'utf8')

describe('conflicting recommendation supersession', () => {
  it('only lets contradiction-resolution material intelligence retire predecessors', () => {
    expect(sql).toContain("provenance->>'source'")
    expect(sql).toContain("material-intelligence-recommendation-runtime")
    expect(sql).toContain("provenance->>'trigger'")
    expect(sql).toContain("contradiction-resolution")
  })

  it('retires same-goal same-scope predecessors and binds them to the replacement', () => {
    expect(sql).toContain("old.goal_id = v_new.goal_id")
    expect(sql).toContain("old.workspace_id is not distinct from v_new.workspace_id")
    expect(sql).toContain("status = 'superseded'")
    expect(sql).toContain('superseded_by = v_new.id')
    expect(sql).toContain('superseded_at = now()')
  })

  it('is service-role only', () => {
    expect(sql).toMatch(/revoke all on function public\.supersede_conflicting_caye_recommendations\(uuid\)[\s\S]*from public, anon, authenticated/i)
    expect(sql).toMatch(/grant execute on function public\.supersede_conflicting_caye_recommendations\(uuid\)[\s\S]*to service_role/i)
  })
})
