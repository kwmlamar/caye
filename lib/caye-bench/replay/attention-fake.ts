import type { ReplayAttentionSeed } from './types'

/**
 * replay/attention-fake.ts
 *
 * A minimal, read-only fake `caye_owner_attention` table so
 * `lib/owner-attention.ts`'s REAL `loadAttentionDelta` +
 * `renderAttentionContext` can run for real during replay, instead of the
 * back-office system prompt going without attention context entirely.
 * This is what makes an "operator-demonstrated-awareness" incident (the
 * 2026-08-26 Autumn McNeill redundant-notification pattern —
 * `lib/owner-attention.test.ts`'s own describe block) something Caye
 * Bench v2 can actually replay through the real fix, not just assert
 * about in the abstract.
 *
 * Read-only on purpose: replay seeds this table from
 * `ReplayTrace.seed.attentionItems` once, at reset, and never calls any
 * of `lib/owner-attention.ts`'s mutation functions during a turn — those
 * are producer/notifier-side (`observeAttentionItem`, `markAttentionNotified`,
 * `recordOperatorAwareness`), not something a composer turn invokes.
 * Query shape mirrors `lib/owner-attention.test.ts`'s own fake exactly
 * (select/eq/order/limit resolving to the seeded rows) so it stays a
 * faithful stand-in for the real query `loadAttentionDelta` issues.
 */

interface QueryChain {
  select: () => QueryChain
  eq: (col: string, val: unknown) => QueryChain
  in: (col: string, vals: unknown[]) => QueryChain
  is: (col: string, val: unknown) => QueryChain
  order: () => QueryChain
  limit: () => Promise<{ data: ReplayAttentionSeed[]; error: null }>
  maybeSingle: () => Promise<{ data: ReplayAttentionSeed | null; error: null }>
  single: () => Promise<{ data: ReplayAttentionSeed | null; error: null }>
  then: (onfulfilled?: (v: { data: ReplayAttentionSeed[]; error: null }) => unknown) => Promise<unknown>
}

export function makeFakeAttentionClient(rows: ReplayAttentionSeed[]) {
  function chain(filtered: ReplayAttentionSeed[]): QueryChain {
    const self = (): QueryChain => chain(filtered)
    return {
      select: self,
      eq: (col, val) => chain(filtered.filter((r) => (r as unknown as Record<string, unknown>)[col] === val)),
      in: (col, vals) => chain(filtered.filter((r) => vals.includes((r as unknown as Record<string, unknown>)[col]))),
      is: (col, val) => chain(filtered.filter((r) => (val === null ? (r as unknown as Record<string, unknown>)[col] == null : (r as unknown as Record<string, unknown>)[col] === val))),
      order: self,
      limit: () => Promise.resolve({ data: filtered, error: null }),
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (onfulfilled) => Promise.resolve({ data: filtered, error: null }).then(onfulfilled),
    }
  }

  return {
    from(table: string) {
      // Any OTHER table a production code path happens to touch during a
      // turn (e.g. `lib/business-facts.ts`'s `fetchBusinessFacts`, called
      // unconditionally by `runToolLoop`'s front-desk evidence-grounding
      // setup, independent of which tools a turn's script actually
      // calls) resolves to an empty result rather than throwing or
      // reaching real Supabase — replay's real durable data for anything
      // this fake doesn't specifically model lives in `WorkspaceState`
      // (production-state.ts), read through the real tool contracts
      // (production-tools.ts), not through this table directly. Empty is
      // the honest, safe default: "isolated state" means no live
      // database read ever succeeds, not that every table is faithfully
      // modeled.
      if (table !== 'caye_owner_attention') return chain([])
      return chain(rows)
    },
  }
}
