import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }))

import { runPostIngestionIntelligenceFormation, type IntelligenceItemSnapshot, type RelationProposal } from './relation-runtime'

type Row = Record<string, any>

class FakeQuery implements PromiseLike<{ data: any; error: null }> {
  private filters: Array<(row: Row) => boolean> = []
  private containsFilter: Record<string, unknown> | null = null
  private limitCount: number | null = null

  constructor(private readonly db: FakeDb, private readonly table: string) {}

  select() { return this }
  order() { return this }
  or() { return this }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this }
  neq(column: string, value: unknown) { this.filters.push((row) => row[column] !== value); return this }
  is(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this }
  contains(_column: string, value: Record<string, unknown>) { this.containsFilter = value; return this }
  limit(value: number) { this.limitCount = value; return this }

  private rows(): Row[] {
    let rows = [...(this.db.tables[this.table] ?? [])]
    for (const filter of this.filters) rows = rows.filter(filter)
    if (this.containsFilter) {
      rows = rows.filter((row) => Object.entries(this.containsFilter!).every(([key, value]) => row.provenance?.[key] === value))
    }
    return this.limitCount == null ? rows : rows.slice(0, this.limitCount)
  }

  async single() {
    const rows = this.rows()
    return { data: rows[0] ?? null, error: null }
  }

  async maybeSingle() {
    const rows = this.rows()
    return { data: rows[0] ?? null, error: null }
  }

  then<TResult1 = { data: any; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.rows(), error: null }).then(onfulfilled, onrejected)
  }
}

class FakeDb {
  tables: Record<string, Row[]>
  relationWrites = 0
  revisionWrites = 0

  constructor(items: IntelligenceItemSnapshot[]) {
    this.tables = {
      intelligence_items: items,
      intelligence_relations: [],
      intelligence_item_claims: [
        { intelligence_item_id: 'item-new', claim_id: 'claim-new' },
        { intelligence_item_id: 'item-old', claim_id: 'claim-old' },
      ],
      research_claims: [
        { id: 'claim-new', semantic_key: 'new', provenance: { canonicalUrl: 'https://independent-a.example/report' } },
        { id: 'claim-old', semantic_key: 'old', provenance: { canonicalUrl: 'https://independent-b.example/report' } },
      ],
      intelligence_belief_revisions: [],
    }
  }

  from(table: string) { return new FakeQuery(this, table) }

  async rpc(name: string, params: Record<string, any>) {
    if (name === 'upsert_grounded_intelligence_relation') {
      this.relationWrites += 1
      return { data: { id: 'relation-1' }, error: null }
    }
    if (name === 'revise_intelligence_belief_confidence') {
      this.revisionWrites += 1
      const id = `revision-${this.revisionWrites}`
      this.tables.intelligence_belief_revisions.push({
        id,
        intelligence_item_id: params.p_intelligence_item_id,
        provenance: params.p_provenance,
      })
      const target = this.tables.intelligence_items.find((row) => row.id === params.p_intelligence_item_id)
      if (target) target.confidence = params.p_revised_confidence
      return { data: { id }, error: null }
    }
    throw new Error(`unexpected rpc ${name}`)
  }
}

function item(overrides: Partial<IntelligenceItemSnapshot>): IntelligenceItemSnapshot {
  return {
    id: 'item-new',
    workspace_id: 'workspace-a',
    scope: 'workspace',
    domain: 'ai',
    topic: 'frontier model economics',
    canonical_claim: 'Inference economics changed materially.',
    semantic_key: 'frontier-economics',
    confidence: 0.6,
    materiality: 1,
    relevance: 0.9,
    observed_at: '2026-08-31T18:00:00.000Z',
    valid_from: '2026-08-31T18:00:00.000Z',
    valid_until: null,
    status: 'current',
    provenance: {},
    ...overrides,
  }
}

describe('post-ingestion formation idempotency', () => {
  it('does not append or compound the same belief revision on rerun', async () => {
    const db = new FakeDb([
      item({ id: 'item-new' }),
      item({ id: 'item-old', observed_at: '2026-08-20T18:00:00.000Z', valid_from: '2026-08-20T18:00:00.000Z', confidence: 0.55 }),
    ])
    const proposer = vi.fn(async (): Promise<RelationProposal[]> => [{
      fromItemId: 'item-new',
      toItemId: 'item-old',
      relationType: 'corroborates',
      rationale: 'Two independent reports corroborate the older belief.',
      supportingResearchClaimIds: ['claim-new', 'claim-old'],
      confidence: 0.84,
    }])

    const first = await runPostIngestionIntelligenceFormation({ itemId: 'item-new', db, proposer })
    const confidenceAfterFirst = db.tables.intelligence_items.find((row) => row.id === 'item-old')!.confidence
    const second = await runPostIngestionIntelligenceFormation({ itemId: 'item-new', db, proposer })
    const confidenceAfterSecond = db.tables.intelligence_items.find((row) => row.id === 'item-old')!.confidence

    expect(first.revisionIds).toEqual(['revision-1'])
    expect(second.revisionIds).toEqual([])
    expect(db.revisionWrites).toBe(1)
    expect(confidenceAfterSecond).toBe(confidenceAfterFirst)
  })
})
