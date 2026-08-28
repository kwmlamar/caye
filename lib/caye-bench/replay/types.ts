import type { BenchActor, BenchEffect, BenchInputEvent } from '../types'
import type { Booking } from '../production-state'

/**
 * replay/types.ts — Caye Bench v2: the versioned replay-trace format.
 *
 * `production history -> sanitized ReplayTrace -> BenchReplayAdapter ->
 * current Caye -> observed replay effects -> invariants/comparison/report`
 *
 * A `ReplayTrace` is deliberately NOT a database dump. It contains only
 * what deterministic evaluation needs: chronological events (reusing
 * `BenchInputEvent`/`BenchActor` from v1 directly — a replay trace IS a
 * `BenchScenario`'s input once seeded and pseudonymized, not a different
 * shape competing with it), enough durable-state seed to reconstruct the
 * relevant slice of a workspace, and a sanitized record of what actually
 * happened historically (`historicalEffects`, in the SAME `BenchEffect`
 * shape the hard-invariant gate and quality scorer already know how to
 * evaluate — see replay/compare.ts). No raw message bodies beyond what
 * `text` on an event carries (already PII-redacted by the sanitizer), no
 * raw customer/operator identity, no arbitrary extra columns.
 */

export const REPLAY_TRACE_SCHEMA_VERSION = 1 as const

export interface ReplaySeedArtifact {
  id: string
  caption: string
  mime: string
}

/** A sanitized slice of `owner_attention` (lib/owner-attention.ts) —
 *  enough for `loadAttentionDelta`/`renderAttentionContext` to run for
 *  real against a fake table (see replay/attention-fake.ts). Optional:
 *  most traces don't need it. Field names mirror the real table's
 *  columns 1:1 so the fake query builder needs no translation layer. */
export interface ReplayAttentionSeed {
  id: string
  workspace_id: string
  subject_type: string
  subject_id: string
  conversation_id: string | null
  title: string
  priority: 'critical' | 'decision' | 'awareness' | 'routine'
  status: 'open' | 'acknowledged' | 'decided' | 'resolved' | 'dismissed'
  first_notified_at: string | null
  last_notified_at: string | null
  notify_count: number
  last_notified_summary: string | null
  acknowledged_at: string | null
  decided_at: string | null
  decision: string | null
  next_action: string | null
  completed_at: string | null
  state_fingerprint: string
  notified_fingerprint: string | null
  operator_aware_fingerprint: string | null
  operator_aware_at: string | null
  operator_aware_summary: string | null
  last_changed_at: string
  digest: string | null
}

export interface ReplaySeed {
  bookings?: Booking[]
  /** fact_key -> value. Sanitized the same way event text is. */
  businessFacts?: Record<string, string>
  artifacts?: ReplaySeedArtifact[]
  attentionItems?: ReplayAttentionSeed[]
  /**
   * operation name -> forced outcome, pre-registered BEFORE replay starts
   * rather than set reactively by a `provider_result` event. A tool call
   * (e.g. `draft_in_inbox`) resolves SYNCHRONOUSLY within the turn that
   * requests it; the real-world ambiguous/failed outcome a
   * `provider_result` event records is usually known only LATER (an
   * async webhook/retry), so by the time that event is chronologically
   * replayed, the triggering tool call already ran. Traces that need a
   * specific call to see a forced outcome pre-register it here; the
   * corresponding `provider_result` event still appears in `events` for
   * the historical record and `historicalEffects` comparison, but its
   * replay handler is a documented no-op (see replay-adapter.ts). */
  forcedProviderOutcomes?: Record<string, 'ambiguous_timeout'>
}

export interface ReplayProvenance {
  sourceSystem: string
  redactionMethod: string
  exportedBy?: string
  notes?: string
}

export interface ReplayTrace {
  schemaVersion: typeof REPLAY_TRACE_SCHEMA_VERSION
  /** Stable id for this trace — used to derive the bench scenario id and
   *  the deterministic replay run id. Never a real conversation/customer
   *  id; assign a short slug when authoring the trace. */
  traceId: string
  /** Pseudonymous workspace id — never a real workspace/customer_id. */
  workspaceId: string
  /** Human-readable, non-identifying summary of what this trace
   *  reconstructs — an incident description, not a customer's story. */
  sourceDescription: string
  /** Links to already-documented incidents (Linear CAY-* ids, or a repo
   *  test/doc path) — provenance for "this is a REAL incident", not raw
   *  production data. */
  incidentRefs?: string[]
  sanitizedAt: string
  startTime: string
  timezone: string
  businessName: string
  actors: BenchActor[]
  events: BenchInputEvent[]
  seed: ReplaySeed
  /** What ACTUALLY happened historically, sanitized into the same
   *  `BenchEffect` shape a replay run produces — enables running the
   *  SAME hard-invariant gate over history itself (was the incident
   *  already a violation?) and the SAME quality metrics, for a genuine
   *  apples-to-apples comparison. See replay/compare.ts. */
  historicalEffects: BenchEffect[]
  provenance: ReplayProvenance
}

// ---------------------------------------------------------------------------
// Sanitizer input — the explicit, versioned boundary between "whatever a
// production export script pulls" and the trace format above. See
// replay/sanitize.ts's header comment for why this exists as its own
// type rather than sanitizing ad hoc.
// ---------------------------------------------------------------------------

export type RawActorRole = BenchActor['role']

export interface RawActorInput {
  /** The real, raw identifier (operator_allowlist id, customer_id,
   *  phone/email) — NEVER written into a ReplayTrace; sanitize.ts hashes
   *  it into a pseudonym and discards the original. */
  rawId: string
  role: RawActorRole
  /** Real display name, if known — used only to redact it out of event
   *  text (`redactPII`'s name-pass); never copied into the output trace. */
  displayName?: string | null
  email?: string | null
  phone?: string | null
}

export interface RawEventInput {
  id: string
  at: string
  channel: BenchInputEvent['channel']
  actorRawId: string
  kind: BenchInputEvent['kind']
  text?: string | null
  data?: Record<string, unknown>
}

export interface RawTraceInput {
  workspaceRawId: string
  sourceDescription: string
  incidentRefs?: string[]
  timezone: string
  businessName: string
  startTime: string
  actors: RawActorInput[]
  events: RawEventInput[]
  seed?: ReplaySeed
  historicalEffects: BenchEffect[]
  provenance: Omit<ReplayProvenance, 'redactionMethod'>
}
