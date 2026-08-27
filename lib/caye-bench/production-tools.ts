import type { Tool } from '../caye-agent/tools/types'
import { businessArtifactRichResult } from '../artifacts/rich-result'
import type { WorkspaceState } from './production-state'

/**
 * production-tools.ts — the fixture tool set the production adapter offers
 * `runToolLoop`. Tool names, risk tiers, and mode restrictions mirror the
 * real registry where it matters for the invariants under test (e.g.
 * `create_customer_booking`/`reschedule_booking` are `modes: ['back-
 * office']` only, matching `lib/caye-agent/tools/write-high/*` exactly —
 * front-desk has no direct booking-write tool in production, only
 * `send_customer_reply`). Execution bodies are safe, in-memory operations
 * against a `WorkspaceState`, not the real Supabase-backed tools — the
 * REAL, unmodified code this adapter exercises is `runToolLoop` itself
 * (role gating, high-risk staging via `production-gate.ts` — which
 * reuses the real `stableArgsKey`/`extractTargetKey` — and the
 * action-claim-guard backstop), not each individual tool body.
 */

export function makeCheckAvailability(): Tool<never> {
  return {
    name: 'check_availability',
    description: 'Check tour/rental availability for a date.',
    risk: 'read',
    roles: ['owner', 'staff', 'founder'],
    modes: ['front-desk', 'back-office'],
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
    async execute() {
      return { ok: true, data: { available: true } }
    },
  }
}

export function makeGetBusinessFact(state: WorkspaceState): Tool<{ fact_key: string }> {
  return {
    name: 'get_business_fact',
    description: "Read a durable business fact (price, pickup location, policy) from this workspace's records.",
    risk: 'read',
    roles: ['owner', 'staff', 'founder'],
    modes: ['front-desk', 'back-office'],
    inputSchema: { type: 'object', properties: { fact_key: { type: 'string' } }, required: ['fact_key'] },
    async execute(args) {
      const fact = state.businessFacts.get(args.fact_key)
      return { ok: true, data: fact ? { value: fact.value } : { value: null } }
    },
  }
}

export function makeUpdateBusinessFact(state: WorkspaceState): Tool<{ fact_key: string; value: string }> {
  return {
    name: 'update_business_fact',
    description: 'Durably correct a business fact. Low-risk, executes immediately.',
    risk: 'low',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: { fact_key: { type: 'string' }, value: { type: 'string' } },
      required: ['fact_key', 'value'],
    },
    async execute(args) {
      state.businessFacts.set(args.fact_key, { value: args.value, correctedAtMs: Date.now() })
      return { ok: true, data: { updated: true, fact_key: args.fact_key, value: args.value } }
    },
  }
}

export function makeSendCustomerReply(): Tool<{ conversation_id: string; body: string; intent?: string }> {
  return {
    name: 'send_customer_reply',
    description: 'Deliver a reply to the customer on this channel. HIGH-RISK, executes immediately once called.',
    risk: 'high',
    roles: ['owner', 'staff', 'founder'],
    modes: ['front-desk'],
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        body: { type: 'string' },
        intent: { type: 'string', description: 'e.g. needs_clarification — for bench observability only.' },
      },
      required: ['conversation_id', 'body'],
    },
    terminatesTurn: true,
    async execute(args) {
      return { ok: true, data: { sent: true, delivered_text: args.body, intent: args.intent ?? null } }
    },
  }
}

export function makeEscalateToOwner(): Tool<{ reason: string }> {
  return {
    name: 'escalate_to_owner',
    description: 'Hand this conversation to the owner instead of answering directly. Low-risk, executes immediately.',
    risk: 'low',
    roles: ['owner', 'staff', 'founder'],
    modes: ['front-desk'],
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    terminatesTurn: true,
    async execute(args) {
      return { ok: true, data: { escalated: true, delivered_text: '', reason: args.reason } }
    },
  }
}

/** Mirrors `create-customer-booking.ts`: `modes: ['back-office']` only,
 *  status starts `'pending'`, never `'confirmed'` on the raw call —
 *  confirmation is the gate's job (`production-gate.ts`). */
export function makeCreateCustomerBooking(state: WorkspaceState): Tool<{ customer_id: string; customer_name: string; tour_type: string; date: string; time?: string }> {
  return {
    name: 'create_customer_booking',
    description: 'Create a pending booking directly from the operator conversation. HIGH-RISK.',
    risk: 'high',
    roles: ['owner', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        customer_name: { type: 'string' },
        tour_type: { type: 'string' },
        date: { type: 'string' },
        time: { type: 'string' },
      },
      required: ['customer_id', 'customer_name', 'tour_type', 'date'],
    },
    async execute(args) {
      const id = `bk_${state.bookings.length + 1}`
      state.bookings.push({
        id,
        customerId: args.customer_id,
        customerName: args.customer_name,
        tourType: args.tour_type,
        date: args.date,
        time: args.time ?? null,
        status: 'confirmed',
        reviewRequestedAt: null,
      })
      return { ok: true, data: { booking_id: id, status: 'confirmed', date: args.date, time: args.time ?? null } }
    },
  }
}

export function makeRescheduleBooking(state: WorkspaceState): Tool<{ booking_id: string; new_date?: string; new_time?: string }> {
  return {
    name: 'reschedule_booking',
    description: 'Move a booking to a new date/time. HIGH-RISK — back-office only.',
    risk: 'high',
    roles: ['owner', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: { booking_id: { type: 'string' }, new_date: { type: 'string' }, new_time: { type: 'string' } },
      required: ['booking_id'],
    },
    async execute(args) {
      const booking = state.bookings.find((b) => b.id === args.booking_id)
      if (!booking) return { ok: false, error: `No booking with id ${args.booking_id}`, status: 'FAILED_PERMANENT' }
      if (booking.status === 'cancelled') return { ok: false, error: 'That booking was already cancelled.', status: 'FAILED_PERMANENT' }
      if (args.new_date) booking.date = args.new_date
      if (args.new_time) booking.time = args.new_time
      return { ok: true, data: { booking_id: booking.id, status: booking.status, date: booking.date, time: booking.time } }
    },
  }
}

export function makeMarkBookingCompleted(state: WorkspaceState): Tool<{ booking_id: string }> {
  return {
    name: 'mark_booking_completed',
    description: 'Mark a past booking as completed. Low-risk, executes immediately.',
    risk: 'low',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: { type: 'object', properties: { booking_id: { type: 'string' } }, required: ['booking_id'] },
    async execute(args) {
      const booking = state.bookings.find((b) => b.id === args.booking_id)
      if (!booking) return { ok: false, error: `No booking with id ${args.booking_id}`, status: 'FAILED_PERMANENT' }
      booking.status = 'completed'
      return { ok: true, data: { booking_id: booking.id, status: 'completed' } }
    },
  }
}

export function makeStoreArtifact(state: WorkspaceState): Tool<{ artifact_id: string; caption: string; mime: string }> {
  return {
    name: 'store_artifact',
    description: 'Durably store an operator-provided artifact (photo/document). Low-risk, executes immediately.',
    risk: 'low',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: { artifact_id: { type: 'string' }, caption: { type: 'string' }, mime: { type: 'string' } },
      required: ['artifact_id', 'caption', 'mime'],
    },
    async execute(args) {
      state.artifacts.set(args.artifact_id, { caption: args.caption, mime: args.mime, storedAtMs: Date.now() })
      return { ok: true, data: { stored: true, artifact_id: args.artifact_id } }
    },
  }
}

/**
 * Mirrors `retrieve_artifact_for_operator`'s trust boundary for real: the
 * REAL, pure `businessArtifactRichResult` (`lib/artifacts/rich-result.ts`)
 * builds the payload, so only an id ever crosses into the rich result —
 * never a caption, never a URL.
 */
export function makeRetrieveArtifact(state: WorkspaceState): Tool<{ artifact_id: string }> {
  return {
    name: 'retrieve_artifact_for_operator',
    description: 'Retrieve a stored artifact for inline display in this conversation.',
    risk: 'low',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: { type: 'object', properties: { artifact_id: { type: 'string' } }, required: ['artifact_id'] },
    async execute(args) {
      const artifact = state.artifacts.get(args.artifact_id)
      if (!artifact) return { ok: false, error: 'No artifact with that id in this workspace.', status: 'FAILED_PERMANENT' }
      return {
        ok: true,
        data: { delivery: 'inline', artifact_id: args.artifact_id, rich_result: businessArtifactRichResult([args.artifact_id]) },
      }
    },
  }
}

/**
 * `draft_in_inbox` — deliberately name-matched to the real tool
 * (`lib/caye-agent/tools/write-high/draft-in-inbox.ts`) whose 2026-08-26
 * incident (staged draft, ambiguous provider timeout) motivated the
 * `false_success_after_ambiguous_failure` invariant in the first place.
 * Reads a forced outcome from `WorkspaceState.forcedProviderOutcomes`
 * (set by a `provider_result` scenario event) instead of guessing.
 */
export function makeDraftInInbox(state: WorkspaceState): Tool<{ conversation_id: string; body: string }> {
  return {
    name: 'draft_in_inbox',
    description: 'Save a reply as a draft in the provider inbox without sending it. Low-risk, executes immediately.',
    risk: 'low',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: { conversation_id: { type: 'string' }, body: { type: 'string' } },
      required: ['conversation_id', 'body'],
    },
    async execute(args) {
      const forced = state.forcedProviderOutcomes.get('draft_in_inbox')
      if (forced === 'ambiguous_timeout') {
        state.forcedProviderOutcomes.delete('draft_in_inbox')
        return { ok: false, error: 'Provider request timed out — no confirmation either way.', status: 'NEEDS_HUMAN', error_code: 'DRAFT_CREATION_UNCERTAIN' }
      }
      return { ok: true, data: { draft_id: `draft_${args.conversation_id}`, sent: false } }
    },
  }
}

export function makeSendReviewRequest(state: WorkspaceState): Tool<{ booking_id: string }> {
  return {
    name: 'send_review_request',
    description: 'Send a post-tour review request. Low-risk, executes immediately.',
    risk: 'low',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: { type: 'object', properties: { booking_id: { type: 'string' } }, required: ['booking_id'] },
    async execute(args) {
      const booking = state.bookings.find((b) => b.id === args.booking_id)
      if (booking) booking.reviewRequestedAt = new Date().toISOString()
      return { ok: true, data: { sent: true } }
    },
  }
}

export function makeGetRecentBookings(state: WorkspaceState): Tool<never> {
  return {
    name: 'get_recent_bookings',
    description: "List this workspace's recent bookings.",
    risk: 'read',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, data: { bookings: state.bookings } }
    },
  }
}
