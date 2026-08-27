import type { Tool } from '../caye-agent/tools/types'
import { wrapWithProductionGate, makeProductionConfirmTool } from './production-gate'
import { instrument, type TurnCallRecord } from './effect-helpers'
import type { WorkspaceState } from './production-state'
import {
  makeCheckAvailability,
  makeGetBusinessFact,
  makeUpdateBusinessFact,
  makeSendCustomerReply,
  makeEscalateToOwner,
  makeCreateCustomerBooking,
  makeRescheduleBooking,
  makeMarkBookingCompleted,
  makeStoreArtifact,
  makeRetrieveArtifact,
  makeDraftInInbox,
  makeSendReviewRequest,
  makeGetRecentBookings,
} from './production-tools'

/**
 * tool-setup.ts
 *
 * The tool registry every Caye Bench adapter offers `runToolLoop` —
 * extracted from `production-adapter.ts` (v1) so `replay-adapter.ts` (v2)
 * builds the exact same real-execution-path tool set against its own
 * `WorkspaceState`, rather than a second copy that could drift.
 */

/** Tools genuinely confirm-gated in production — `create_customer_booking`
 *  and `reschedule_booking` are `write-high`, back-office only, exactly
 *  like the real registry. `send_customer_reply` is ALSO `risk: 'high'`
 *  but is evidence-gated and executes immediately in real production
 *  (STATE.md: front-desk sends are autonomous once evidence supports
 *  them) — it must NOT go through the stage/confirm mechanic here either. */
export const GATED_TOOL_NAMES = new Set(['create_customer_booking', 'reschedule_booking'])

export interface ToolSetup {
  tools: Tool<never>[]
  callSink: { current: TurnCallRecord[] }
}

export function buildToolSetup(state: WorkspaceState): ToolSetup {
  const callSink = { current: [] as TurnCallRecord[] }
  const raw: Tool<never>[] = [
    makeCheckAvailability(),
    makeGetBusinessFact(state),
    makeUpdateBusinessFact(state),
    makeSendCustomerReply(),
    makeEscalateToOwner(),
    makeCreateCustomerBooking(state),
    makeRescheduleBooking(state),
    makeMarkBookingCompleted(state),
    makeStoreArtifact(state),
    makeRetrieveArtifact(state),
    makeDraftInInbox(state),
    makeSendReviewRequest(state),
    makeGetRecentBookings(state),
  ]
  const rawByName = new Map(raw.map((t) => [t.name, t]))
  const gated = raw.map((t) => (GATED_TOOL_NAMES.has(t.name) ? wrapWithProductionGate(t, state.gate, () => Date.now()) : t))
  const confirmTool = makeProductionConfirmTool(state.gate, rawByName, () => Date.now()) as unknown as Tool<never>
  const tools = [...gated, confirmTool].map((t) => instrument(t, callSink))
  return { tools, callSink }
}
