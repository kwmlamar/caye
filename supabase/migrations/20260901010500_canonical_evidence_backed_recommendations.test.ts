import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260901010500_canonical_evidence_backed_recommendations.sql'),
  'utf8'
)
const service = readFileSync(
  join(process.cwd(), 'lib', 'recommendations', 'service.ts'),
  'utf8'
)

describe('canonical evidence-backed recommendation contracts', () => {
  it('models a valid grounded recommendation on canonical intelligence and goals', () => {
    expect(migration).toMatch(/create table if not exists public\.caye_recommendations/i)
    expect(migration).toMatch(/goal_id uuid not null references public\.caye_goals\(id\)/i)
    expect(migration).toMatch(/create table if not exists public\.caye_recommendation_intelligence/i)
    expect(migration).toMatch(/references public\.intelligence_items\(id\)/i)
    expect(migration).toMatch(/create table if not exists public\.caye_recommendation_claims/i)
    expect(migration).toMatch(/references public\.research_claims\(id\)/i)
    expect(migration).toMatch(/recommendation requires a canonical intelligence goal impact/i)
  })

  it('rejects missing or model-only evidence', () => {
    expect(migration).toMatch(/recommendation requires canonical research claim evidence/i)
    expect(migration).toMatch(/recommendation evidence must already exist in canonical intelligence provenance/i)
    expect(migration).toMatch(/from public\.intelligence_item_claims ic/i)
    expect(migration).toMatch(/from public\.intelligence_belief_revision_claims rc/i)
    expect(migration).toMatch(/Founder wording\/model prose is never evidence/i)
  })

  it('rejects cross-workspace or incompatible scoped intelligence', () => {
    expect(migration).toMatch(/i\.scope <> 'global'/i)
    expect(migration).toMatch(/i\.scope is distinct from v_goal\.scope/i)
    expect(migration).toMatch(/i\.workspace_id is distinct from v_goal\.workspace_id/i)
    expect(migration).toMatch(/must be global or share goal scope and workspace/i)
  })

  it('rejects inactive or superseded goals', () => {
    expect(migration).toMatch(/v_goal\.status <> 'active'/i)
    expect(migration).toMatch(/v_goal\.superseded_at is not null/i)
    expect(migration).toMatch(/active non-superseded canonical goal/i)
  })

  it('converges duplicate synthesis through a deterministic fingerprint', () => {
    expect(migration).toMatch(/v_fingerprint := encode\(digest/i)
    expect(migration).toMatch(/caye-recommendation-v1/i)
    expect(migration).toMatch(/array_to_string\(v_item_ids, ','\)/i)
    expect(migration).toMatch(/fingerprint text not null unique/i)
    expect(migration).toMatch(/on conflict \(fingerprint\) do update/i)
  })

  it('keeps browser roles unable to mutate recommendation state', () => {
    for (const table of [
      'caye_recommendations',
      'caye_recommendation_intelligence',
      'caye_recommendation_belief_revisions',
      'caye_recommendation_claims',
    ]) {
      expect(migration).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
    }
    expect(migration).toMatch(/revoke all on public\.caye_recommendations,[\s\S]*from anon, authenticated/i)
    expect(migration).toMatch(/revoke all on function public\.upsert_grounded_caye_recommendation[\s\S]*from public, anon, authenticated/i)
  })

  it('permits mutation only through the service-role security-definer writer', () => {
    expect(migration).toMatch(/create or replace function public\.upsert_grounded_caye_recommendation[\s\S]*language plpgsql[\s\S]*security definer[\s\S]*set search_path = public/i)
    expect(migration).toMatch(/grant execute on function public\.upsert_grounded_caye_recommendation[\s\S]*to service_role/i)
    expect(service).toMatch(/import 'server-only'/)
    expect(service).toMatch(/createServiceClient\(\)/)
    expect(service).toMatch(/\.rpc\('upsert_grounded_caye_recommendation'/)
    expect(service).not.toMatch(/createServerClient|NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  })

  it('supports multiple intelligence items and optional belief revisions', () => {
    expect(migration).toMatch(/p_intelligence_item_ids uuid\[\]/i)
    expect(migration).toMatch(/p_belief_revision_ids uuid\[\]/i)
    expect(migration).toMatch(/foreach v_item_id in array v_item_ids/i)
    expect(migration).toMatch(/foreach v_revision_id in array v_revision_ids/i)
    expect(migration).toMatch(/belief revisions must belong to originating intelligence/i)
  })

  it('preserves contradiction and uncertainty by enforcing an evidence confidence ceiling', () => {
    expect(migration).toMatch(/i\.status not in \('current','contested'\)/i)
    expect(migration).toMatch(/select min\(bound\) into v_confidence_ceiling/i)
    expect(migration).toMatch(/select i\.confidence as bound/i)
    expect(migration).toMatch(/select r\.revised_confidence as bound/i)
    expect(migration).toMatch(/recommendation confidence exceeds evidence-supported bound/i)
  })

  it('does not introduce execution state', () => {
    expect(migration).toMatch(/Contains recommendation state only; execution\/decision state belongs elsewhere/i)
    expect(migration).not.toMatch(/execution_status|executed_at|tool_call|payment_status|message_status/i)
  })
})
