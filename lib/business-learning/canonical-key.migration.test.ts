import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Canonical-key derivation for the legacy business-fact backfill.
 *
 * The version that shipped keyed every logistics fact mentioning a
 * meeting/pickup point as `workspace.meeting_point` unless service_id was set —
 * and no legacy fact has service_id set. On the live Bimini workspace that put
 * a single-service fact and an explicitly business-wide fact in one bucket and
 * superseded the first. Both sentences below are that exact pair.
 *
 * The property under test is not "does it assign good keys". It is:
 *
 *   a fact whose scope cannot be PROVEN never receives a key,
 *   and therefore can never be superseded by this migration.
 *
 * Tests are written against generic shapes — named offerings, place
 * qualifiers, universal quantifiers — not against Bimini or "Heritage Tour".
 */

const MIGRATION = join(
  __dirname, '..', '..', 'supabase', 'migrations',
  '20260901_continuous_business_learning.sql'
)

const WS = '11111111-1111-1111-1111-111111111111'
const OTHER_WS = '22222222-2222-2222-2222-222222222222'

describe('derive_business_fact_canonical_key', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.booking_services (
        id uuid primary key default gen_random_uuid(), workspace_id uuid, name text
      );
      create table public.business_facts (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null, service_id uuid, category text,
        fact text not null, source text, memory_type text, authority_kind text,
        knowledge_mode text, canonical_key text, valid_from timestamptz,
        created_at timestamptz not null default now(),
        superseded_at timestamptz, superseded_by uuid
      );
    `)
    // Only the derivation functions; the surrounding migration needs tables
    // this fixture deliberately does not build.
    const sql = readFileSync(MIGRATION, 'utf8')
    const from = sql.indexOf('create or replace function public.business_fact_canonical_property')
    const to = sql.indexOf('revoke all on function public.business_fact_canonical_property')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    await db.exec(sql.slice(from, to))
  })

  afterAll(async () => { await db.close() })

  async function key(fact: string, opts: { serviceId?: string | null; category?: string } = {}) {
    const { rows } = await db.query<{ k: string | null }>(
      `select public.derive_business_fact_canonical_key($1, $2, $3, $4) as k`,
      [WS, opts.serviceId ?? null, opts.category ?? 'logistics', fact]
    )
    return rows[0].k
  }

  describe('scope precedence', () => {
    it('uses service_id when the fact is structurally linked to a service', async () => {
      const sid = '33333333-3333-3333-3333-333333333333'
      expect(await key('The meeting point is the north dock.', { serviceId: sid }))
        .toBe(`service.${sid}.meeting_point`)
    })

    it('keys explicitly business-wide facts to the workspace', async () => {
      expect(await key('The pickup location for all tours is the Casino Tram Stop.'))
        .toBe('workspace.meeting_point')
      expect(await key('Every tour has its meeting point at the main office.'))
        .toBe('workspace.meeting_point')
    })

    it('does not recognise property phrasings outside the shared vocabulary', async () => {
      // The vocabulary deliberately mirrors propertyAlias() in
      // lib/business-learning/model.ts and is deliberately narrow. "meets at"
      // reads as a meeting point to a human but is not in the vocabulary, so
      // the fact stays unkeyed. Widening this is a product decision that needs
      // its own dry run; guessing here is what caused the incident.
      expect(await key('Every booking meets at the main office.')).toBeNull()
    })

    it('WITHHOLDS a key when the fact names an offering it cannot resolve', async () => {
      // The incident case. No matching booking_services row exists, so scope is
      // unproven and the fact must stay untouched rather than become
      // workspace-wide.
      expect(await key('The meeting point for the Heritage Tour is the pink building by the dock.'))
        .toBeNull()
      expect(await key('Pickup for the Sunset Charter is at berth 4.')).toBeNull()
    })

    it('resolves a named offering once it is a real service of that workspace', async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.booking_services (workspace_id, name)
         values ($1, 'Heritage Tour') returning id`, [WS]
      )
      const sid = rows[0].id
      expect(await key('The meeting point for the Heritage Tour is the pink building by the dock.'))
        .toBe(`service.${sid}.meeting_point`)
      // …and still not for a different workspace's fact
      const { rows: other } = await db.query<{ k: string | null }>(
        `select public.derive_business_fact_canonical_key($1, null, 'logistics', $2) as k`,
        [OTHER_WS, 'The meeting point for the Heritage Tour is the pink building by the dock.']
      )
      expect(other[0].k).toBeNull()
      await db.query(`delete from public.booking_services where id = $1`, [sid])
    })

    it('prefers the longest matching service name', async () => {
      const { rows } = await db.query<{ id: string; name: string }>(
        `insert into public.booking_services (workspace_id, name)
         values ($1, 'Reef Tour'), ($1, 'Reef Tour Deluxe') returning id, name`, [WS]
      )
      const deluxe = rows.find((r) => r.name === 'Reef Tour Deluxe')!
      expect(await key('Meeting point for the Reef Tour Deluxe is the pier.'))
        .toBe(`service.${deluxe.id}.meeting_point`)
      await db.query(`delete from public.booking_services where workspace_id = $1`, [WS])
    })

    it('a specific qualifier outranks a universal quantifier', async () => {
      // "all guests" would otherwise read as workspace-wide, but the sentence
      // is scoped to one named offering.
      expect(await key('All guests on the Heritage Tour meet at the pink building.'))
        .toBeNull()
    })

    it('withholds a key for place-qualified facts', async () => {
      expect(await key('In Exuma, roundtrip transportation from the airport is $30 per person.'))
        .toBeNull()
      expect(await key('The Nassau office is located on Sands Road.')).toBeNull()
    })

    it('withholds a key when no property is recognised', async () => {
      expect(await key('Guests should bring sunscreen and a towel.')).toBeNull()
    })

    it('withholds a key when scope is simply silent', async () => {
      // No service, no universal quantifier, no specific qualifier.
      expect(await key('Meeting point instructions are sent the night before.')).toBeNull()
    })

    it('is scoped to the logistics category until other categories are audited', async () => {
      expect(await key('The pickup location for all tours is the tram stop.', { category: 'policy' }))
        .toBeNull()
    })
  })

  describe('the backfill cannot supersede an unresolved fact', () => {
    it('leaves the incident pair distinct and supersedes nothing', async () => {
      await db.query(`delete from public.business_facts`)
      await db.query(
        `insert into public.business_facts
           (workspace_id, category, fact, source, memory_type, authority_kind, knowledge_mode)
         values
           ($1,'logistics','The meeting point for the Heritage Tour is the pink building by the dock.','owner-direct','fact','owner','explicit'),
           ($1,'logistics','The pickup location for all tours is the Casino Tram Stop.','owner-direct','fact','owner','explicit')`,
        [WS]
      )

      await db.exec(`
        update public.business_facts f
        set canonical_key = public.derive_business_fact_canonical_key(
          f.workspace_id, f.service_id, f.category, f.fact)
        where f.canonical_key is null
          and public.derive_business_fact_canonical_key(
                f.workspace_id, f.service_id, f.category, f.fact) is not null;
      `)

      const { rows } = await db.query<{ canonical_key: string | null; fact: string }>(
        `select canonical_key, fact from public.business_facts order by fact`
      )
      expect(rows).toHaveLength(2)
      expect(rows[0].canonical_key).toBeNull() // Heritage Tour — unresolved, safe
      expect(rows[1].canonical_key).toBe('workspace.meeting_point')

      // No partition has more than one member, so nothing is superseded.
      const { rows: dupes } = await db.query<{ n: number }>(
        `select count(*)::int as n from (
           select canonical_key from public.business_facts
           where superseded_at is null and canonical_key is not null
           group by workspace_id, canonical_key having count(*) > 1
         ) t`
      )
      expect(dupes[0].n).toBe(0)
    })

    it('still supersedes two facts that genuinely share one resolved property', async () => {
      // The migration must not become a no-op: same workspace, same explicitly
      // business-wide property, two competing values — one is genuinely stale.
      await db.query(`delete from public.business_facts`)
      await db.query(
        `insert into public.business_facts
           (workspace_id, category, fact, source, memory_type, authority_kind, knowledge_mode, created_at)
         values
           ($1,'logistics','The pickup location for all tours is the old ferry dock.','email','fact','operator','observed', now() - interval '10 days'),
           ($1,'logistics','The pickup location for all tours is the Casino Tram Stop.','owner-direct','fact','owner','explicit', now())`,
        [WS]
      )
      await db.exec(`
        update public.business_facts f
        set canonical_key = public.derive_business_fact_canonical_key(
          f.workspace_id, f.service_id, f.category, f.fact)
        where f.canonical_key is null
          and public.derive_business_fact_canonical_key(
                f.workspace_id, f.service_id, f.category, f.fact) is not null;
      `)
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from (
           select canonical_key from public.business_facts
           where superseded_at is null and canonical_key is not null
           group by workspace_id, canonical_key having count(*) > 1
         ) t`
      )
      expect(rows[0].n).toBe(1) // the owner-direct row wins; the stale email row retires
    })
  })
})
