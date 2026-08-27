import type { ReplayAttentionSeed } from './types'

/**
 * replay/attention-double.ts
 *
 * Mirrors `model-double.ts`'s mutable-box pattern for the one other real
 * seam a replay trace can opt into: `@/lib/supabase-server`'s
 * `createServiceClient`, mocked ONLY so the real `loadAttentionDelta`
 * (`lib/owner-attention.ts`) can run against `replay/attention-fake.ts`'s
 * in-memory table instead of a real database. `BenchReplayAdapter.reset()`
 * sets `attentionDouble.current` from the trace's own
 * `seed.attentionItems`; a trace with none leaves it as `[]`, which is
 * indistinguishable from "no open attention items" — the honest default.
 */
export const attentionDouble: { current: ReplayAttentionSeed[] } = { current: [] }
