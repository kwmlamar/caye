import { sanitizeRawTrace } from '../sanitize'
import type { RawTraceInput } from '../types'
import type { BenchModelRound } from '../../model-double'

/**
 * fixtures/autumn-mcneill-redundant-notification.ts
 *
 * Reconstructs the 2026-08-26 "Autumn McNeill" incident documented in
 * `lib/owner-attention.test.ts`'s own describe block ("attention delta —
 * operator-demonstrated awareness"): the operator had already shown, by
 * her own actions, that she knew a booking-confirmed item and a new-
 * pending item were handled — but Caye's back-office reply announced
 * them anyway ("Sonja's booking confirmed and Autumn's new pending are
 * already on your radar; the resolved escalation needs nothing
 * further."). Per that test file's own comment: "Announcing that nothing
 * needs attention IS itself the interruption this instruction rules
 * out." The fix (operator-demonstrated-awareness bucketing +
 * `renderAttentionContext`'s "do NOT name these" instruction) is already
 * live on `main`.
 *
 * This is the one fixture that wires the REAL `loadAttentionDelta` /
 * `renderAttentionContext` (`lib/owner-attention.ts`) against a seeded
 * fake `caye_owner_attention` row — see `replay/attention-fake.ts` and
 * `replay/cli-runner.test.ts`'s mock wiring. `historicalEffects` marks
 * the redundant recap as an unnecessary operator interruption (a
 * BEHAVIOR regression, not a hard-invariant violation — this is
 * precisely the category-2 "unnecessary operator interruption" case the
 * task asks Caye Bench v2 to distinguish from category-1 safety issues).
 */
const raw: RawTraceInput = {
  workspaceRawId: 'raw-ws-autumn-mcneill',
  sourceDescription: 'Operator-demonstrated-awareness: Caye must not announce items the operator already showed she knows about.',
  incidentRefs: ['lib/owner-attention.test.ts (2026-08-26 Autumn McNeill incident)'],
  timezone: 'America/Nassau',
  businessName: 'Bimini Island Tours (replay fixture)',
  startTime: '2026-08-26T01:40:00.000Z',
  actors: [{ rawId: 'raw-operator-mrs-max', role: 'operator', displayName: 'Mrs. Max' }],
  events: [
    {
      id: 'evt-1',
      at: '2026-08-26T01:40:00.000Z',
      channel: 'whatsapp',
      actorRawId: 'raw-operator-mrs-max',
      kind: 'message',
      text: "What's the latest on the front desk?",
    },
  ],
  seed: {
    attentionItems: [
      {
        id: 'att-1',
        workspace_id: 'placeholder',
        subject_type: 'escalation',
        subject_id: 'esc-autumn-1',
        conversation_id: 'conv-autumn',
        title: "Autumn's new pending booking + Sonja confirmed",
        priority: 'awareness',
        status: 'open',
        first_notified_at: null,
        last_notified_at: null,
        notify_count: 0,
        last_notified_summary: null,
        acknowledged_at: null,
        decided_at: null,
        decision: null,
        next_action: null,
        completed_at: null,
        state_fingerprint: 'fp-1',
        notified_fingerprint: null,
        // The operator already showed awareness of THIS exact state
        // (same fingerprint) by handling it herself — e.g. she sent the
        // customer-facing reply in this conversation directly.
        operator_aware_fingerprint: 'fp-1',
        operator_aware_at: '2026-08-26T01:39:06Z',
        operator_aware_summary: 'Operator sent a customer-facing reply in this conversation themselves.',
        last_changed_at: '2026-08-26T01:39:06Z',
        digest: null,
      },
    ],
  },
  historicalEffects: [
    {
      id: 'hist-1',
      workspaceId: 'placeholder',
      at: '2026-08-26T01:40:03.000Z',
      kind: 'message',
      channel: 'whatsapp',
      risk: 'read',
      outcome: 'success',
      operatorInterruption: true,
      useful: false,
      claim: "Sonja's booking confirmed and Autumn's new pending are already on your radar; the resolved escalation needs nothing further.",
      evidence: [{ kind: 'policy', ref: 'owner-attention', summary: 'redundant recap of an operator-already-known item' }],
    },
  ],
  provenance: { sourceSystem: 'reconstructed-from-repo-incident-record', notes: 'See lib/owner-attention.test.ts for the real incident record this reconstructs — not a literal raw export.' },
}

export const autumnMcneillRedundantNotificationTrace = sanitizeRawTrace(raw, {
  traceId: 'autumn-mcneill-redundant-notification',
  salt: 'caye-bench-v2-fixture-salt-not-a-real-export-secret',
  sanitizedAt: '2026-08-27T00:00:00.000Z',
})

/** See jeff-dworkin-draft-failure.ts's companion export for why this
 *  lives alongside the trace rather than inline in a test file. */
export const autumnMcneillRedundantNotificationTurnScripts: Record<string, BenchModelRound[]> = {
  'evt-1': [{ text: 'All quiet on the front desk — nothing new needs your attention.' }],
}
