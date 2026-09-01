import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20260831a_bounded_self_improvement_provenance.sql'),
  'utf8',
)

describe('bounded self-improvement provenance migration', () => {
  it('durably roots self-improvement sessions in one canonical recommendation', () => {
    expect(sql).toContain('recommendation_id uuid references public.caye_recommendations(id) on delete restrict')
    expect(sql).toContain('recommendation_fingerprint text')
    expect(sql).toContain("recommendation_provenance jsonb not null default '{}'::jsonb")
    expect(sql).toContain('self_improvement_session boolean not null default false')
    expect(sql).toContain('create unique index if not exists caye_coding_sessions_one_per_recommendation_idx')
  })

  it('makes recommendation origin immutable and scope checked', () => {
    expect(sql).toContain('coding-session recommendation provenance is immutable')
    expect(sql).toContain('coding-session recommendation fingerprint mismatch')
    expect(sql).toContain('coding-session recommendation is outside workspace scope')
    expect(sql).toContain('operator recommendation cannot be relabeled as workspace engineering')
  })
})
