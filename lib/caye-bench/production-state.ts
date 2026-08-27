import type Anthropic from '@anthropic-ai/sdk'
import { createProductionGateStore, type ProductionGateStore } from './production-gate'
import type { SyntheticTurn } from '../caye-agent/replay/fixtures/helpers'

/**
 * production-state.ts — the durable, isolated state one workspace's worth
 * of scenario turns read and write against. This is the "isolated state"
 * half of "reusing Caye's real execution paths against isolated
 * state/providers": real production reads/writes Supabase; the production
 * adapter reads/writes this instead, through the same tool contracts
 * (production-tools.ts), so a fact corrected in one turn is still the
 * fact a completely different, later conversation reads — the actual
 * property several canonical scenarios (operator-correction-fresh-
 * context, artifact-fresh-retrieval, conflicting-stale-fact) test.
 *
 * Created fresh per scenario by `ProductionBenchAdapter.reset()` — see
 * `BenchAdapter.reset`'s doc comment in types.ts for why that matters.
 */

export interface Booking {
  id: string
  customerId: string
  customerName: string
  tourType: string
  date: string | null
  time: string | null
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled'
  reviewRequestedAt: string | null
}

export interface BusinessFact {
  value: string
  correctedAtMs: number
}

export interface StoredArtifact {
  caption: string
  mime: string
  storedAtMs: number
}

export type ProviderOutcome = 'ambiguous_timeout'

export interface WorkspaceState {
  workspaceId: string
  bookings: Booking[]
  businessFacts: Map<string, BusinessFact>
  artifacts: Map<string, StoredArtifact>
  /** Real Anthropic-format conversation history, per actor id — the
   *  continuity substrate for cross-channel scenarios. A "fresh context"
   *  turn in a scenario uses a NEW actor id, which naturally starts empty
   *  here, exactly the way a brand-new conversation would in production. */
  histories: Map<string, Anthropic.MessageParam[]>
  /** Front-desk-only: raw text turns per customer actor, rebuilt into a
   *  real `CayeSituation` each turn via `buildSyntheticSituation` (the
   *  same helper `lib/caye-agent/replay/fixtures/*` uses) so front-desk
   *  gets the production situation-aware system prompt, not a hand-rolled
   *  one. */
  rawTurnsByActor: Map<string, SyntheticTurn[]>
  gate: ProductionGateStore
  /** Set by a `provider_result` event; read and cleared by whichever tool
   *  call represents that outcome next. Models an external provider that
   *  answers asynchronously/ambiguously rather than the adapter guessing. */
  forcedProviderOutcomes: Map<string, ProviderOutcome>
  /** Last time a customer's thread went silent after Caye's own reply,
   *  for the ghosted-lead proactive check — mirrors
   *  `GhostedLeadCandidate.last_message_at` in lib/nudge-eligibility.ts. */
  lastCayeReplyAt: Map<string, number>
}

export function createWorkspaceState(workspaceId: string): WorkspaceState {
  return {
    workspaceId,
    bookings: [],
    businessFacts: new Map(),
    artifacts: new Map(),
    histories: new Map(),
    rawTurnsByActor: new Map(),
    gate: createProductionGateStore(),
    forcedProviderOutcomes: new Map(),
    lastCayeReplyAt: new Map(),
  }
}

export function historyFor(state: WorkspaceState, actorId: string): Anthropic.MessageParam[] {
  let h = state.histories.get(actorId)
  if (!h) {
    h = []
    state.histories.set(actorId, h)
  }
  return h
}

export function rawTurnsFor(state: WorkspaceState, actorId: string): SyntheticTurn[] {
  let t = state.rawTurnsByActor.get(actorId)
  if (!t) {
    t = []
    state.rawTurnsByActor.set(actorId, t)
  }
  return t
}
