import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260830_outcome_driven_adaptive_learning.sql'), 'utf8')

describe('outcome-driven adaptive learning migration', () => {
  it('extends the existing candidate quarantine instead of creating a parallel learning-memory table', () => {
    expect(sql).toContain('alter table public.business_fact_candidates')
    expect(sql).not.toMatch(/create\s+table\s+[^;]*learning/i)
    expect(sql).toContain("'outcome_learning'::text")
  })

  it('stores structured evidence and bounded confidence on candidates', () => {
    expect(sql).toContain("evidence_refs jsonb not null default '[]'::jsonb")
    expect(sql).toContain('confidence numeric')
    expect(sql).toContain("jsonb_typeof(evidence_refs) = 'array'")
    expect(sql).toContain('confidence >= 0 and confidence <= 1')
  })

  it('keeps outcome-learning candidates workspace keyed and separately indexed', () => {
    expect(sql).toContain('on public.business_fact_candidates (workspace_id, canonical_key, status, last_seen_at desc)')
    expect(sql).toContain("where source = 'outcome_learning'")
  })
})
