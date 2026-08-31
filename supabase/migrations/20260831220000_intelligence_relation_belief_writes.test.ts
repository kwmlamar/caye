import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260831220000_intelligence_relation_belief_writes.sql'),
  'utf8'
)

describe('intelligence relation and belief write contracts', () => {
  it('extends the canonical intelligence substrate with evidence-addressable relations', () => {
    expect(migration).toMatch(/create table if not exists public\.intelligence_relation_claims/i)
    expect(migration).toMatch(/references public\.intelligence_relations\(id\)/i)
    expect(migration).toMatch(/references public\.research_claims\(id\)/i)
    expect(migration).toMatch(/create or replace function public\.upsert_grounded_intelligence_relation/i)
    expect(migration).toMatch(/on conflict \(from_item_id, to_item_id, relation_type\) do update/i)
  })

  it('requires explicit endpoints, same intelligence scope, and endpoint-grounded claim evidence', () => {
    expect(migration).toMatch(/p_from_item_id uuid/i)
    expect(migration).toMatch(/p_to_item_id uuid/i)
    expect(migration).toMatch(/p_evidence_claim_ids uuid\[\]/i)
    expect(migration).toMatch(/endpoints must share scope and workspace/i)
    expect(migration).toMatch(/grounded relation requires research claim evidence/i)
    expect(migration).toMatch(/from public\.intelligence_item_claims item_claim/i)
    expect(migration).toMatch(/item_claim\.intelligence_item_id in \(p_from_item_id, p_to_item_id\)/i)
    expect(migration).toMatch(/relation evidence must already ground at least one endpoint/i)
    expect(migration).not.toMatch(/cross\s+join/i)
  })

  it('records an append-only evidence-backed confidence revision before updating belief state', () => {
    expect(migration).toMatch(/create table if not exists public\.intelligence_belief_revisions/i)
    expect(migration).toMatch(/prior_confidence numeric\(4,3\)/i)
    expect(migration).toMatch(/revised_confidence numeric\(4,3\) not null/i)
    expect(migration).toMatch(/rationale text not null/i)
    expect(migration).toMatch(/create or replace function public\.revise_intelligence_belief_confidence/i)
    expect(migration).toMatch(/where id = p_intelligence_item_id\s+for update/i)
    expect(migration).toMatch(/insert into public\.intelligence_belief_revisions[\s\S]*update public\.intelligence_items/i)
    expect(migration).toMatch(/belief revision requires research claim evidence/i)
  })

  it('keeps write authority service-role only', () => {
    expect(migration).toMatch(/revoke all on function public\.upsert_grounded_intelligence_relation[\s\S]*from public, anon, authenticated/i)
    expect(migration).toMatch(/grant execute on function public\.upsert_grounded_intelligence_relation[\s\S]*to service_role/i)
    expect(migration).toMatch(/revoke all on function public\.revise_intelligence_belief_confidence[\s\S]*from public, anon, authenticated/i)
    expect(migration).toMatch(/grant execute on function public\.revise_intelligence_belief_confidence[\s\S]*to service_role/i)
  })
})
