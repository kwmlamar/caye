import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260901012000_canonical_recommendation_decisions.sql'),
  'utf8'
)
const service = readFileSync(join(process.cwd(), 'lib', 'recommendations', 'decisions.ts'), 'utf8')

describe('canonical recommendation decision contracts', () => {
  it('references exactly one canonical recommendation', () => {
    expect(migration).toMatch(/recommendation_id uuid not null references public\.caye_recommendations\(id\)/i)
    expect(migration).toMatch(/decision text not null check \(decision in \('accepted','rejected','deferred','cancelled'\)\)/i)
  })

  it('records actor and existing authority provenance without granting authority', () => {
    expect(migration).toMatch(/actor_kind text not null/i)
    expect(migration).toMatch(/authority_provenance jsonb not null/i)
    expect(migration).toMatch(/autonomous decision requires existing authority provenance/i)
    expect(migration).toMatch(/never interprets required_authority as a grant/i)
  })

  it('fails closed on cross-workspace decisions', () => {
    expect(migration).toMatch(/v_rec\.workspace_id is distinct from p_workspace_id/i)
    expect(migration).toMatch(/recommendation decision workspace mismatch/i)
  })

  it('keeps acceptance distinct from execution', () => {
    expect(migration).toMatch(/acceptance is not execution evidence/i)
    expect(migration).not.toMatch(/execution_status|executed_at|tool_call_id/i)
  })

  it('mirrors decision status onto the canonical recommendation without replacing it', () => {
    expect(migration).toMatch(/update public\.caye_recommendations/i)
    expect(migration).toMatch(/when 'accepted' then 'accepted'/i)
    expect(migration).toMatch(/when 'cancelled' then 'withdrawn'/i)
    expect(migration).toMatch(/status <> 'superseded'/i)
  })

  it('is deterministic and service-role only', () => {
    expect(migration).toMatch(/caye-recommendation-decision-v1/i)
    expect(migration).toMatch(/fingerprint text not null unique/i)
    expect(migration).toMatch(/on conflict \(fingerprint\) do update/i)
    expect(migration).toMatch(/security definer[\s\S]*set search_path = public/i)
    expect(migration).toMatch(/grant execute on function public\.record_caye_recommendation_decision[\s\S]*to service_role/i)
    expect(service).toMatch(/import 'server-only'/)
    expect(service).toMatch(/\.rpc\('record_caye_recommendation_decision'/)
  })
})
