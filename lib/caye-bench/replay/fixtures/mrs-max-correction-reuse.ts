import { sanitizeRawTrace } from '../sanitize'
import type { RawTraceInput } from '../types'

/**
 * fixtures/mrs-max-correction-reuse.ts
 *
 * Reconstructs the durable-correction failure shape this repo's own
 * historical-replay fixtures already document under the "Mrs. Max"
 * pattern (see `lib/caye-agent/replay/fixtures/nbc-laney-scope.ts`,
 * `correction-narrowing.ts`, and the "Cruise Tram Stop" pickup-location
 * example used throughout STATE.md-adjacent docs): an operator corrects a
 * durable business fact in one conversation; a LATER, unrelated
 * conversation is asked about the same fact.
 *
 * `historicalEffects` encodes the failure this trace exists to check for:
 * the later conversation used the STALE pre-correction value —
 * `ignored_authoritative_correction`, historically. Replay routes the
 * later question through the real `get_business_fact` tool
 * (`production-tools.ts`) against the SAME durable `WorkspaceState` the
 * correction wrote into, so it reads the corrected value for real.
 */
const raw: RawTraceInput = {
  workspaceRawId: 'raw-ws-mrs-max-correction',
  sourceDescription: 'Operator corrects a durable pickup-location fact; a later, unrelated customer conversation must use the corrected value, not the stale one.',
  incidentRefs: ['lib/caye-agent/replay/fixtures/nbc-laney-scope.ts', 'lib/caye-agent/replay/fixtures/correction-narrowing.ts'],
  timezone: 'America/Nassau',
  businessName: 'Bimini Island Tours (replay fixture)',
  startTime: '2026-08-20T11:00:00.000Z',
  actors: [
    { rawId: 'raw-operator-mrs-max', role: 'operator', displayName: 'Mrs. Max' },
    { rawId: 'raw-customer-theo', role: 'customer', displayName: 'Theo Grant' },
  ],
  events: [
    {
      id: 'evt-1',
      at: '2026-08-20T11:00:00.000Z',
      channel: 'whatsapp',
      actorRawId: 'raw-operator-mrs-max',
      kind: 'correction',
      text: 'Cruise guests use the Casino Tram Stop now, not the old marina pickup.',
      data: { factKey: 'cruise_pickup_location', factValue: 'Casino Tram Stop' },
    },
    {
      id: 'evt-2',
      at: '2026-08-22T09:00:00.000Z',
      channel: 'email',
      actorRawId: 'raw-customer-theo',
      kind: 'message',
      text: 'Hi! Where do cruise guests meet you for pickup?',
    },
  ],
  seed: {
    businessFacts: { cruise_pickup_location: 'the old marina' },
  },
  historicalEffects: [
    {
      id: 'hist-1',
      workspaceId: 'placeholder',
      at: '2026-08-20T11:00:01.000Z',
      kind: 'state_write',
      risk: 'low_write',
      consequential: true,
      authorized: true,
      outcome: 'success',
      factKey: 'cruise_pickup_location',
      factValue: 'Casino Tram Stop',
      evidence: [{ kind: 'operator_instruction', ref: 'evt-1' }],
    },
    {
      id: 'hist-2',
      workspaceId: 'placeholder',
      at: '2026-08-22T09:00:05.000Z',
      kind: 'message',
      channel: 'email',
      risk: 'read',
      outcome: 'success',
      factKey: 'cruise_pickup_location',
      factValue: 'the old marina',
      claim: 'Pickup for cruise guests is at the old marina.',
      evidence: [{ kind: 'authoritative_state', ref: 'legacy-cached-fact' }],
    },
  ],
  provenance: { sourceSystem: 'reconstructed-from-repo-incident-pattern', notes: 'Synthesized from the documented "Mrs. Max correction" failure shape already covered by lib/caye-agent/replay fixtures — not a literal raw export.' },
}

export const mrsMaxCorrectionReuseTrace = sanitizeRawTrace(raw, {
  traceId: 'mrs-max-correction-reuse',
  salt: 'caye-bench-v2-fixture-salt-not-a-real-export-secret',
  sanitizedAt: '2026-08-27T00:00:00.000Z',
})
