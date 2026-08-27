import type { BenchActor, BenchScenario } from './types'

const customer = (id: string, name: string): BenchActor => ({ id, name, role: 'customer' })
const operator = (id: string, name: string): BenchActor => ({ id, name, role: 'operator' })
const system: BenchActor = { id: 'system', name: 'System', role: 'system' }

const BASE = '2026-09-01'

export const canonicalBenchScenarios: BenchScenario[] = [
  {
    id: 'booking-lifecycle',
    name: 'Normal booking lifecycle',
    description: 'Inquiry → booking → reminder → completion without unnecessary owner intervention.',
    workspaceId: 'bench-bimini',
    initialTime: `${BASE}T09:00:00.000Z`,
    tags: ['booking', 'happy-path'],
    events: [
      { id: 'book-1', at: `${BASE}T09:00:00.000Z`, channel: 'email', actor: customer('maya', 'Maya'), kind: 'message', text: 'Can two of us book the Heritage Tour for September 5 at 9am?' },
      { id: 'book-2', at: `${BASE}T09:05:00.000Z`, channel: 'email', actor: customer('maya', 'Maya'), kind: 'message', text: 'Yes, please book it.' },
      { id: 'book-3', at: '2026-09-04T13:00:00.000Z', channel: 'system', actor: system, kind: 'timer', data: { purpose: 'day_before_reminder' } },
      { id: 'book-4', at: '2026-09-05T14:00:00.000Z', channel: 'system', actor: system, kind: 'state_change', data: { bookingStatus: 'completed' } },
    ],
    assertions: [
      { id: 'booking-created', description: 'A booking write completes.', check: ({ effects }) => effects.some((e) => e.kind === 'state_write' && e.factKey === 'booking_status' && e.factValue === 'confirmed' && e.outcome === 'success') },
      { id: 'reminder-useful', description: 'The proactive reminder is useful.', check: ({ effects }) => effects.some((e) => e.kind === 'proactive_action' && e.useful === true) },
    ],
  },
  {
    id: 'ambiguity-clarification',
    name: 'Ambiguous request requires clarification',
    description: 'Caye must not make a consequential choice when the customer request is genuinely ambiguous.',
    workspaceId: 'bench-bimini',
    initialTime: `${BASE}T10:00:00.000Z`,
    tags: ['clarification', 'authority'],
    events: [
      { id: 'amb-1', at: `${BASE}T10:00:00.000Z`, channel: 'whatsapp', actor: customer('lee', 'Lee'), kind: 'message', text: 'Book us the tour tomorrow.' },
    ],
    assertions: [
      { id: 'no-blind-booking', description: 'No booking write occurs before clarification.', check: ({ effects }) => !effects.some((e) => e.kind === 'state_write' && e.factKey === 'booking_status') },
      { id: 'clarifies', description: 'Caye asks for clarification.', check: ({ effects }) => effects.some((e) => e.kind === 'message' && e.metadata?.intent === 'needs_clarification') },
    ],
  },
  {
    id: 'operator-correction-fresh-context',
    name: 'Operator correction survives fresh context',
    description: 'Mrs. Max changes a reusable pickup instruction and a later fresh interaction uses the corrected value.',
    workspaceId: 'bench-bimini',
    initialTime: `${BASE}T11:00:00.000Z`,
    tags: ['learning', 'fresh-context'],
    events: [
      { id: 'corr-1', at: `${BASE}T11:00:00.000Z`, channel: 'whatsapp', actor: operator('mrs-max', 'Mrs. Max'), kind: 'correction', text: 'Cruise guests use the Casino Tram Stop now.', data: { factKey: 'cruise_pickup_location', factValue: 'Casino Tram Stop' } },
      { id: 'corr-2', at: '2026-09-02T11:00:00.000Z', channel: 'caye_direct', actor: operator('mrs-max', 'Mrs. Max'), kind: 'message', text: 'Where do cruise guests meet us?' },
    ],
    assertions: [
      { id: 'corrected-location-used', description: 'Fresh-context answer uses the corrected pickup location.', check: ({ effects }) => effects.some((e) => e.factKey === 'cruise_pickup_location' && e.factValue === 'Casino Tram Stop') },
    ],
  },
  {
    id: 'booking-time-change',
    name: 'Booking time mutation',
    description: 'An operator-directed time change must mutate authoritative booking state before customer notification.',
    workspaceId: 'bench-bimini',
    initialTime: `${BASE}T12:00:00.000Z`,
    tags: ['booking', 'mutation', 'grounding'],
    events: [
      { id: 'time-1', at: `${BASE}T12:00:00.000Z`, channel: 'whatsapp', actor: operator('mrs-max', 'Mrs. Max'), kind: 'correction', text: 'Move Sonja from 9am to 10am.', data: { factKey: 'sonja_booking_time', factValue: '10:00' } },
    ],
    assertions: [
      { id: 'time-mutated', description: 'Authoritative booking time becomes 10:00.', check: ({ effects }) => effects.some((e) => e.kind === 'state_write' && e.factKey === 'sonja_booking_time' && e.factValue === '10:00' && e.outcome === 'success') },
    ],
  },
  {
    id: 'cross-channel-continuity',
    name: 'Cross-channel continuity',
    description: 'A customer moving from email to WhatsApp remains one coherent piece of work.',
    workspaceId: 'bench-bimini',
    initialTime: `${BASE}T13:00:00.000Z`,
    tags: ['cross-channel', 'identity'],
    events: [
      { id: 'cross-1', at: `${BASE}T13:00:00.000Z`, channel: 'email', actor: customer('jeff', 'Jeff'), kind: 'message', text: 'Where is the Heritage Tour pickup?' },
      { id: 'cross-2', at: `${BASE}T13:10:00.000Z`, channel: 'whatsapp', actor: customer('jeff', 'Jeff'), kind: 'message', text: 'Following up on my email — where should we meet?' },
    ],
    assertions: [
      { id: 'single-customer-context', description: 'Effects remain associated with Jeff across channels.', check: ({ effects }) => effects.filter((e) => e.kind === 'message').every((e) => e.metadata?.customerId == null || e.metadata.customerId === 'jeff') },
    ],
  },
  {
    id: 'artifact-fresh-retrieval',
    name: 'Artifact memory survives fresh context',
    description: 'An operator-provided pickup image remains retrievable in a later conversation.',
    workspaceId: 'bench-bimini',
    initialTime: `${BASE}T14:00:00.000Z`,
    tags: ['artifact', 'multimodal', 'fresh-context'],
    events: [
      { id: 'art-1', at: `${BASE}T14:00:00.000Z`, channel: 'whatsapp', actor: operator('mrs-max', 'Mrs. Max'), kind: 'artifact', text: 'This is the pickup spot for cruise guests. Remember this.', data: { artifactId: 'pickup-photo-1', mime: 'image/jpeg' } },
      { id: 'art-2', at: '2026-09-03T14:00:00.000Z', channel: 'caye_direct', actor: operator('mrs-max', 'Mrs. Max'), kind: 'message', text: 'Show me that pickup photo I sent you.' },
    ],
    assertions: [
      { id: 'original-returned', description: 'The stored original artifact is returned.', check: ({ effects }) => effects.some((e) => e.kind === 'artifact_return' && e.metadata?.artifactId === 'pickup-photo-1' && e.outcome === 'success') },
    ],
  },
  {
    id: 'ambiguous-provider-failure',
    name: 'Ambiguous provider failure is not success',
    description: 'An uncertain external write never becomes a confident success or blind retry.',
    workspaceId: 'bench-bimini',
    initialTime: `${BASE}T15:00:00.000Z`,
    tags: ['failure', 'idempotency'],
    events: [
      { id: 'fail-1', at: `${BASE}T15:00:00.000Z`, channel: 'whatsapp', actor: operator('mrs-max', 'Mrs. Max'), kind: 'message', text: 'Draft that reply in Jeff’s inbox. Do not send it.' },
      { id: 'fail-2', at: `${BASE}T15:00:05.000Z`, channel: 'system', actor: system, kind: 'provider_result', data: { outcome: 'ambiguous_timeout', operation: 'draft_in_inbox' } },
    ],
    assertions: [
      { id: 'no-confident-success', description: 'No effect claims successful draft creation after ambiguity.', check: ({ effects }) => !effects.some((e) => e.outcome === 'success' && e.metadata?.operation === 'draft_in_inbox') },
    ],
  },
  {
    id: 'conflicting-stale-fact',
    name: 'Stale business fact loses to correction',
    description: 'A corrected standing fact must prevent the old value from resurfacing later.',
    workspaceId: 'bench-bimini',
    initialTime: `${BASE}T16:00:00.000Z`,
    tags: ['memory', 'conflict'],
    events: [
      { id: 'fact-1', at: `${BASE}T16:00:00.000Z`, channel: 'whatsapp', actor: operator('mrs-max', 'Mrs. Max'), kind: 'correction', text: 'Pickup is Casino Tram Stop, not the pink building.', data: { factKey: 'tour_pickup', factValue: 'Casino Tram Stop' } },
      { id: 'fact-2', at: '2026-09-04T16:00:00.000Z', channel: 'email', actor: customer('ava', 'Ava'), kind: 'message', text: 'Where is pickup?' },
    ],
    assertions: [
      { id: 'stale-fact-absent', description: 'The stale pink-building value does not reappear as current.', check: ({ effects }) => !effects.some((e) => e.factKey === 'tour_pickup' && e.factValue === 'pink building') },
    ],
  },
  {
    id: 'proactive-stale-work',
    name: 'Proactive stale-work handling',
    description: 'Caye follows up on genuinely stale work without manufacturing owner attention.',
    workspaceId: 'bench-bimini',
    initialTime: `${BASE}T17:00:00.000Z`,
    tags: ['proactive', 'attention'],
    events: [
      { id: 'pro-1', at: `${BASE}T17:00:00.000Z`, channel: 'email', actor: customer('jonathan', 'Jonathan'), kind: 'message', text: 'Can you coordinate snorkeling through a partner?' },
      { id: 'pro-2', at: '2026-09-08T17:00:00.000Z', channel: 'system', actor: system, kind: 'timer', data: { purpose: 'stale_work_scan' } },
    ],
    assertions: [
      { id: 'useful-proactivity', description: 'Any proactive action is marked useful and relevant.', check: ({ effects }) => effects.some((e) => e.kind === 'proactive_action' && e.useful === true) },
      { id: 'no-noise-escalation', description: 'No useless operator interruption occurs.', check: ({ effects }) => !effects.some((e) => e.operatorInterruption && e.useful === false) },
    ],
  },
  {
    id: 'bimini-week',
    name: 'Bimini week',
    description: 'A compact multi-day stress scenario mixing customers, corrections, artifacts, booking changes, failures, and proactive work.',
    workspaceId: 'bench-bimini',
    initialTime: '2026-09-07T09:00:00.000Z',
    seed: 20260907,
    tags: ['multi-day', 'stress', 'bimini'],
    events: [
      { id: 'week-1', at: '2026-09-07T09:00:00.000Z', channel: 'email', actor: customer('a', 'Ari'), kind: 'message', text: 'Can 4 of us tour Wednesday morning?' },
      { id: 'week-2', at: '2026-09-07T09:03:00.000Z', channel: 'whatsapp', actor: customer('b', 'Bea'), kind: 'message', text: 'Where do cruise guests meet you?' },
      { id: 'week-3', at: '2026-09-07T11:00:00.000Z', channel: 'whatsapp', actor: operator('mrs-max', 'Mrs. Max'), kind: 'correction', text: 'Use Casino Tram Stop for cruise pickup going forward.', data: { factKey: 'cruise_pickup_location', factValue: 'Casino Tram Stop' } },
      { id: 'week-4', at: '2026-09-08T10:00:00.000Z', channel: 'whatsapp', actor: operator('mrs-max', 'Mrs. Max'), kind: 'artifact', text: 'This is the new pickup photo.', data: { artifactId: 'week-pickup-photo', mime: 'image/jpeg' } },
      { id: 'week-5', at: '2026-09-09T12:00:00.000Z', channel: 'whatsapp', actor: operator('mrs-max', 'Mrs. Max'), kind: 'correction', text: 'Move Ari to 10am.', data: { factKey: 'ari_booking_time', factValue: '10:00' } },
      { id: 'week-6', at: '2026-09-09T12:01:00.000Z', channel: 'system', actor: system, kind: 'provider_result', data: { outcome: 'ambiguous_timeout', operation: 'customer_notification' } },
      { id: 'week-7', at: '2026-09-10T09:00:00.000Z', channel: 'caye_direct', actor: operator('mrs-max', 'Mrs. Max'), kind: 'message', text: 'Show me the new pickup photo.' },
      { id: 'week-8', at: '2026-09-11T16:00:00.000Z', channel: 'system', actor: system, kind: 'timer', data: { purpose: 'stale_work_scan' } },
    ],
    assertions: [
      { id: 'week-correction-held', description: 'Corrected pickup instruction remains current.', check: ({ effects }) => !effects.some((e) => e.factKey === 'cruise_pickup_location' && e.factValue !== 'Casino Tram Stop') },
      { id: 'week-artifact-return', description: 'The new pickup artifact can be returned later.', check: ({ effects }) => effects.some((e) => e.kind === 'artifact_return' && e.metadata?.artifactId === 'week-pickup-photo') },
      { id: 'week-no-false-success', description: 'Ambiguous provider outcome never becomes a confident success.', check: ({ effects }) => !effects.some((e) => e.outcome === 'success' && e.uncertainty === 'ambiguous') },
    ],
  },
]
