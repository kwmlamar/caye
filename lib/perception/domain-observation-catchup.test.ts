import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type Row = {
  id: number
  occurred_at: string
  type: string
  actor_kind: string
  is_failure: boolean
  conversation_id: string | null
  payload: Record<string, unknown>
}

function freshness(row: Row): string {
  const value = row.type.startsWith('domain.') && typeof row.payload.observed_at === 'string'
    ? row.payload.observed_at
    : row.occurred_at
  return new Date(value).toISOString()
}

function mergeRows(ordinary: Row[], observed: Row[], limit: number): Row[] {
  const byId = new Map<number, Row>()
  for (const row of [...ordinary, ...observed]) byId.set(row.id, row)
  return [...byId.values()]
    .sort((a, b) => freshness(b).localeCompare(freshness(a)))
    .slice(0, limit)
}

describe('external domain perception catch-up behavior', () => {
  let db: PGlite
  const workspaceId = '00000000-0000-0000-0000-000000000001'
  const cutoff = '2026-09-02T00:00:00.000Z'
  const limit = 3

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table workspace_events (
        id bigint generated always as identity primary key,
        workspace_id uuid not null,
        occurred_at timestamptz not null,
        type text not null,
        actor_kind text not null,
        is_failure boolean not null default false,
        conversation_id uuid,
        payload jsonb not null default '{}'::jsonb
      );

      create index workspace_events_domain_observed_at_idx
        on workspace_events (workspace_id, ((payload ->> 'observed_at')) desc)
        where type like 'domain.%';
    `)

    const insert = async (
      occurredAt: string,
      type: string,
      actorKind: string,
      observedAt: string | null,
    ) => {
      await db.query(
        `insert into workspace_events
           (workspace_id, occurred_at, type, actor_kind, is_failure, payload)
         values ($1, $2::timestamptz, $3, $4, false, $5::jsonb)`,
        [
          workspaceId,
          occurredAt,
          type,
          actorKind,
          JSON.stringify(observedAt ? { observed_at: observedAt } : {}),
        ],
      )
    }

    // Five old-source events were all first observed after the outage. There
    // are more matches than the feed limit, so ordering before limit matters.
    for (const [minute, entity] of [
      ['01:00:00', 'one'],
      ['02:00:00', 'two'],
      ['03:00:00', 'three'],
      ['04:00:00', 'four'],
      ['05:00:00', 'five'],
    ]) {
      await insert(
        '2026-08-01T12:00:00.000Z',
        `domain.purchase_order.${entity}`,
        'outside',
        `2026-09-02T${minute}.000Z`,
      )
    }

    // This domain row is recent in both clocks and therefore appears in both
    // ordinary and catch-up query results. The merge must emit it once.
    await insert(
      '2026-09-02T04:40:00.000Z',
      'domain.purchase_order.recent',
      'outside',
      '2026-09-02T04:45:00.000Z',
    )

    // Ordinary recent activity remains governed by source/local chronology.
    await insert(
      '2026-09-02T04:50:00.000Z',
      'message.inbound',
      'outside',
      null,
    )

    // Historical non-domain activity must not be resurrected merely because
    // the domain catch-up path exists.
    await insert(
      '2026-08-01T12:00:00.000Z',
      'message.inbound',
      'outside',
      null,
    )

    // Bootstrap may have the newest observation timestamp but system actors
    // are intentionally not reportable and must be filtered in the database.
    await insert(
      '2026-08-01T12:00:00.000Z',
      'domain.purchase_order.bootstrap_observed',
      'system',
      '2026-09-02T06:00:00.000Z',
    )
  })

  afterAll(async () => db.close())

  it('returns newest observations before limit, preserves ordinary semantics, and deduplicates paths', async () => {
    const ordinary = (await db.query<Row>(
      `select id, occurred_at::text, type, actor_kind, is_failure, conversation_id, payload
         from workspace_events
        where workspace_id = $1
          and occurred_at >= $2::timestamptz
          and (actor_kind = 'outside' or is_failure = true)
        order by occurred_at desc
        limit $3`,
      [workspaceId, cutoff, limit],
    )).rows

    const observed = (await db.query<Row>(
      `select id, occurred_at::text, type, actor_kind, is_failure, conversation_id, payload
         from workspace_events
        where workspace_id = $1
          and type like 'domain.%'
          and payload ->> 'observed_at' >= $2
          and (actor_kind = 'outside' or is_failure = true)
        order by payload ->> 'observed_at' desc
        limit $3`,
      [workspaceId, cutoff, limit],
    )).rows

    expect(observed).toHaveLength(limit)
    expect(observed.map((row) => row.type)).toEqual([
      'domain.purchase_order.five',
      'domain.purchase_order.recent',
      'domain.purchase_order.four',
    ])
    expect(observed[0].occurred_at).toContain('2026-08-01')
    expect(observed.some((row) => row.type.endsWith('bootstrap_observed'))).toBe(false)

    const recentId = observed.find((row) => row.type === 'domain.purchase_order.recent')?.id
    expect(recentId).toBeDefined()
    expect(ordinary.some((row) => row.id === recentId)).toBe(true)

    const merged = mergeRows(ordinary, observed, limit)
    expect(new Set(merged.map((row) => row.id)).size).toBe(merged.length)
    expect(merged.map((row) => row.type)).toEqual([
      'domain.purchase_order.five',
      'message.inbound',
      'domain.purchase_order.recent',
    ])

    const surfaced = [...ordinary, ...observed, ...merged]
    expect(surfaced.filter((row) => row.type === 'domain.purchase_order.recent').length).toBeGreaterThan(1)
    expect(merged.filter((row) => row.type === 'domain.purchase_order.recent')).toHaveLength(1)
    expect(merged.some((row) => row.type === 'domain.purchase_order.five')).toBe(true)
    expect(merged.some((row) => row.type === 'domain.purchase_order.bootstrap_observed')).toBe(false)

    const historicalNonDomain = await db.query<Row>(
      `select id, occurred_at::text, type, actor_kind, is_failure, conversation_id, payload
         from workspace_events
        where type = 'message.inbound'
          and occurred_at < $1::timestamptz`,
      [cutoff],
    )
    expect(historicalNonDomain.rows).toHaveLength(1)
    expect(merged.some((row) => row.id === historicalNonDomain.rows[0].id)).toBe(false)
  })
})
