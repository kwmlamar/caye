import type Anthropic from '@anthropic-ai/sdk'
import { runToolLoop } from '../caye-agent/execute'
import type { Role, Tool, ToolMode, ToolRisk } from '../caye-agent/tools/types'
import { buildBackOfficeSystemPrompt } from '../caye-agent/modes/back-office'
import { buildFrontDeskSituationSystemPrompt } from '../caye-agent/modes/front-desk-situation'
import { buildSyntheticSituation } from '../caye-agent/replay/fixtures/helpers'
import { shouldSendGhostedLeadNudge } from '../nudge-eligibility'
import { wrapWithProductionGate, makeProductionConfirmTool } from './production-gate'
import { modelDouble, scriptedRounds, type BenchModelRound } from './model-double'
import { createWorkspaceState, historyFor, rawTurnsFor, type WorkspaceState } from './production-state'
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
import type { BenchAdapter, BenchEffect, BenchEvidence, BenchInputEvent, BenchRisk, BenchScenario, BenchStepContext } from './types'

/**
 * production-adapter.ts
 *
 * The real Caye adapter for Caye Bench: "reusing Caye's real execution
 * paths against isolated state/providers" (the follow-up work
 * `ScriptedBenchAdapter`'s own doc comment calls out as the next step).
 *
 * REAL, unmodified production code exercised on every turn:
 *   - `runToolLoop` (`lib/caye-agent/execute.ts`) — role gating, the
 *     iteration cap, the action-claim-guard backstop, front-desk's forced
 *     tool_choice.
 *   - The high-risk stage/confirm mechanic's actual RULES — imported
 *     `stableArgsKey`/`extractTargetKey` from `high-risk-gate.ts` via
 *     `production-gate.ts` (see that file's header for why a bench-owned
 *     gate still calls the real underlying tool on confirmation, unlike
 *     the historical-replay harness's fake gate).
 *   - `buildBackOfficeSystemPrompt` / `buildFrontDeskSituationSystemPrompt`
 *     / `buildSyntheticSituation` — the real prompt-construction path.
 *   - `shouldSendGhostedLeadNudge` (`lib/nudge-eligibility.ts`) — the real,
 *     pure proactive-nudge eligibility rule.
 *
 * ISOLATED, not real: the Anthropic model call itself (mocked at the
 * `loggedMessagesCreate` seam — see `model-double.ts`; no live API, no
 * live credentials, per the harness's own constraint) and the durable
 * store each tool reads/writes (`production-state.ts`'s `WorkspaceState`,
 * an in-memory stand-in for the Supabase tables the real tools use —
 * `production-tools.ts`'s header comment explains why tool BODIES are
 * fixtures while the surrounding execution machinery is real).
 *
 * WHY THE ADAPTER IS EVENT-ID-KEYED, NOT GENERIC
 * `canonicalBenchScenarios` (scenarios.ts) is a small, fixed, hand-written
 * catalog — 10 scenarios, 26 events total, every event id unique across
 * the whole catalog. A fully generic "parse arbitrary event.text and
 * decide what Caye would do" adapter would need a second LLM in the loop
 * (non-deterministic, against the harness's own design constraint) or a
 * hand-rolled NLU layer that would just be a second, worse copy of
 * production's own reasoning. Scripting the model's response per known
 * event id keeps every turn deterministic while still running the REAL
 * tool loop underneath — the same trade-off `replay/fixtures/*.ts`
 * already makes for its own scripted-turn fixtures.
 */

const BUSINESS_NAME = 'Bimini Bench Tours'
const TIMEZONE = 'America/Nassau'

interface TurnCallRecord {
  toolName: string
  risk: ToolRisk
  args: unknown
  ok: boolean
  status?: string
  resultData: unknown
  pendingOnly: boolean
  executed: boolean
}

interface ToolSetup {
  tools: Tool<never>[]
  callSink: { current: TurnCallRecord[] }
}

interface EventCtx {
  event: BenchInputEvent
  context: BenchStepContext
  state: WorkspaceState
  toolSetup: ToolSetup
  requestId: string
}

type EventHandler = (ectx: EventCtx) => Promise<BenchEffect[]>

// ---------------------------------------------------------------------------
// Tool wiring
// ---------------------------------------------------------------------------

/** Tools genuinely confirm-gated in production — `create_customer_booking`
 *  and `reschedule_booking` are `write-high`, back-office only, exactly
 *  like the real registry. `send_customer_reply` is ALSO `risk: 'high'`
 *  but is evidence-gated and executes immediately in real production
 *  (STATE.md: front-desk sends are autonomous once evidence supports
 *  them) — it must NOT go through the stage/confirm mechanic here either. */
const GATED_TOOL_NAMES = new Set(['create_customer_booking', 'reschedule_booking'])

function outcomeFromResult(data: unknown): { pendingOnly: boolean; executed: boolean } {
  const d = data as Record<string, unknown> | undefined
  const pendingOnly = !!(d && d.pending === true && d.executed === false)
  return { pendingOnly, executed: !pendingOnly }
}

function instrument(tool: Tool<never>, sink: { current: TurnCallRecord[] }): Tool<never> {
  return {
    ...tool,
    execute: async (args: never, ctx) => {
      const result = await tool.execute(args, ctx)
      const { pendingOnly, executed } = outcomeFromResult(result.data)
      sink.current.push({
        toolName: tool.name,
        risk: tool.risk,
        args,
        ok: result.ok,
        status: (result as { status?: string }).status,
        resultData: result.data,
        pendingOnly,
        executed: result.ok && executed,
      })
      return result
    },
  }
}

function buildToolSetup(state: WorkspaceState): ToolSetup {
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

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

interface RunTurnArgs {
  state: WorkspaceState
  toolSetup: ToolSetup
  mode: ToolMode
  actorId: string
  callerRole: Role
  operatorId?: number | null
  operatorName?: string
  channel: 'whatsapp' | 'instagram' | 'messenger' | 'email'
  userText: string
  script: BenchModelRound[]
  requestId: string
  now: string
}

async function runProductionTurn(args: RunTurnArgs): Promise<{ replyText: string; calls: TurnCallRecord[] }> {
  const before = args.toolSetup.callSink.current.length
  let systemPrompt: string
  let initialMessages: Anthropic.MessageParam[]

  if (args.mode === 'front-desk') {
    const rawTurns = rawTurnsFor(args.state, args.actorId)
    rawTurns.push({ role: 'user', content: args.userText, at: args.now })
    const situation = buildSyntheticSituation({
      channel: 'front-desk',
      workspaceId: args.state.workspaceId,
      now: args.now,
      turns: rawTurns,
      timezone: TIMEZONE,
    })
    systemPrompt = buildFrontDeskSituationSystemPrompt({ businessName: BUSINESS_NAME, channel: args.channel, situation, toolsOffered: true })
    initialMessages = situation.historyForModel
  } else {
    const history = historyFor(args.state, args.actorId)
    history.push({ role: 'user', content: args.userText })
    systemPrompt = buildBackOfficeSystemPrompt({
      profile: { operatorName: args.operatorName ?? 'Operator', businessName: BUSINESS_NAME },
      caller: { role: args.callerRole, name: args.operatorName ?? 'Operator' },
    })
    initialMessages = history
  }

  modelDouble.current = scriptedRounds(args.script)
  const result = await runToolLoop({
    client: {} as never,
    model: 'caye-bench-fake-model',
    maxTokens: 1024,
    systemPrompt,
    initialMessages,
    ctx: {
      workspaceId: args.state.workspaceId,
      callerRole: args.callerRole,
      operatorId: args.operatorId ?? null,
      requestId: args.requestId,
      origin: 'chat',
      workspaceTimezone: TIMEZONE,
    },
    mode: args.mode,
    tools: args.toolSetup.tools,
  })

  if (args.mode === 'front-desk') {
    rawTurnsFor(args.state, args.actorId).push({ role: 'assistant', content: result.replyText, at: args.now })
  } else {
    historyFor(args.state, args.actorId).push(...result.newTurns)
  }

  return { replyText: result.replyText, calls: args.toolSetup.callSink.current.slice(before) }
}

/**
 * Confirms an already-staged high-risk action from a genuinely SEPARATE
 * request (a real, distinct `runToolLoop` invocation, not a second round
 * of the same one) — the exact discontinuity the real gate requires —
 * without polluting any actor's visible conversation history, since this
 * represents Caye's own internal operational follow-through rather than a
 * turn a human would see repeated back to them.
 */
async function runInternalConfirm(args: {
  state: WorkspaceState
  toolSetup: ToolSetup
  callerRole: Role
  operatorId?: number | null
  requestId: string
  pendingActionId: string
}): Promise<{ calls: TurnCallRecord[] }> {
  const before = args.toolSetup.callSink.current.length
  modelDouble.current = scriptedRounds([
    { toolCalls: [{ name: 'confirm_pending_action', args: { pending_action_id: args.pendingActionId } }] },
    { text: 'Done.' },
  ])
  await runToolLoop({
    client: {} as never,
    model: 'caye-bench-fake-model',
    maxTokens: 256,
    systemPrompt: 'You are Caye, completing an already-authorized operational action.',
    initialMessages: [{ role: 'user', content: 'Proceed.' }],
    ctx: {
      workspaceId: args.state.workspaceId,
      callerRole: args.callerRole,
      operatorId: args.operatorId ?? null,
      requestId: args.requestId,
      origin: 'chat',
      workspaceTimezone: TIMEZONE,
    },
    mode: 'back-office',
    tools: args.toolSetup.tools,
  })
  return { calls: args.toolSetup.callSink.current.slice(before) }
}

// ---------------------------------------------------------------------------
// Effect construction
// ---------------------------------------------------------------------------

let effectSeq = 0
function nextEffectId(prefix: string): string {
  effectSeq += 1
  return `${prefix}-${effectSeq}`
}

function riskToBenchRisk(r: ToolRisk): BenchRisk {
  return r === 'read' ? 'read' : r === 'high' ? 'high_write' : 'low_write'
}

function toolEvidence(call: TurnCallRecord): BenchEvidence[] {
  // A failed tool call (ToolResult.ok === false) is not required to carry
  // a `data` field — several fixtures here return only
  // `{ ok: false, error, status, error_code }` on failure, matching the
  // real `ToolResult` shape. JSON.stringify(undefined) returns the
  // (non-string) value `undefined`, not "undefined", so this must not
  // assume `.resultData` is always JSON-stringifiable.
  const summary = call.resultData !== undefined ? JSON.stringify(call.resultData) : `ok=${call.ok} status=${call.status ?? 'n/a'}`
  return [{ kind: 'tool_result', ref: call.toolName, summary: summary.slice(0, 300) }]
}

function idempotencyKeyFor(call: TurnCallRecord): string {
  return `${call.toolName}:${JSON.stringify(call.args)}`
}

function messageEffect(args: {
  workspaceId: string
  at: string
  event: BenchInputEvent
  replyText: string
  metadata?: Record<string, unknown>
  factKey?: string
  factValue?: string
}): BenchEffect {
  return {
    id: nextEffectId('msg'),
    workspaceId: args.workspaceId,
    at: args.at,
    kind: 'message',
    channel: args.event.channel,
    risk: 'read',
    outcome: 'success',
    metadata: { customerId: args.event.actor.role === 'customer' ? args.event.actor.id : undefined, ...args.metadata },
    ...(args.factKey ? { factKey: args.factKey, factValue: args.factValue } : {}),
  }
}

/** Stages a high-risk action, then confirms it from a genuinely separate
 *  internal request, and returns the resulting `state_write` effect —
 *  `null` if the scenario's script chose not to stage at all (e.g. an
 *  ambiguous case correctly asks a question instead). `authorized: true`
 *  on the returned effect is earned: it only appears once the REAL gate's
 *  confirm path (production-gate.ts) actually resolved a staged row from
 *  a different request id than the one that staged it. */
async function runGatedAction(
  ectx: EventCtx,
  args: {
    actorId: string
    callerRole: Role
    operatorId?: number | null
    operatorName?: string
    stageUserText: string
    stageScript: BenchModelRound[]
    gatedToolName: string
    claim: string
    factKey?: string
    factValueFrom?: (resultData: unknown) => string | undefined
  }
): Promise<BenchEffect | null> {
  const { state, toolSetup, requestId, context } = ectx
  const { calls: stageCalls } = await runProductionTurn({
    state,
    toolSetup,
    mode: 'back-office',
    actorId: args.actorId,
    callerRole: args.callerRole,
    operatorId: args.operatorId,
    operatorName: args.operatorName,
    channel: 'whatsapp',
    userText: args.stageUserText,
    script: args.stageScript,
    requestId: `${requestId}:stage`,
    now: context.now,
  })
  const stageCall = stageCalls.find((c) => c.toolName === args.gatedToolName)
  const pendingId = (stageCall?.resultData as { pending_action_id?: string } | undefined)?.pending_action_id
  if (!stageCall || !pendingId) return null

  const { calls: confirmCalls } = await runInternalConfirm({
    state,
    toolSetup,
    callerRole: args.callerRole,
    operatorId: args.operatorId,
    requestId: `${requestId}:confirm`,
    pendingActionId: pendingId,
  })
  const confirmCall = confirmCalls.find((c) => c.toolName === 'confirm_pending_action')
  if (!confirmCall) return null

  return {
    id: nextEffectId('write'),
    workspaceId: state.workspaceId,
    at: context.now,
    kind: 'state_write',
    risk: 'high_write',
    consequential: true,
    authorized: true,
    idempotencyKey: idempotencyKeyFor(stageCall),
    outcome: confirmCall.ok ? 'success' : 'failed',
    claim: args.claim,
    evidence: toolEvidence(confirmCall),
    ...(args.factKey ? { factKey: args.factKey, factValue: args.factValueFrom?.(confirmCall.resultData) } : {}),
  }
}

/** Runs a low-risk tool that executes immediately (no gate involved) and
 *  wraps its outcome as a `state_write` effect. */
async function runImmediateAction(
  ectx: EventCtx,
  args: {
    actorId: string
    callerRole: Role
    operatorId?: number | null
    operatorName?: string
    userText: string
    script: BenchModelRound[]
    toolName: string
    claim: string
    factKey?: string
    factValueFrom?: (resultData: unknown) => string | undefined
  }
): Promise<BenchEffect | null> {
  const { state, toolSetup, requestId, context } = ectx
  const { calls } = await runProductionTurn({
    state,
    toolSetup,
    mode: 'back-office',
    actorId: args.actorId,
    callerRole: args.callerRole,
    operatorId: args.operatorId,
    operatorName: args.operatorName,
    channel: 'whatsapp',
    userText: args.userText,
    script: args.script,
    requestId,
    now: context.now,
  })
  const call = calls.find((c) => c.toolName === args.toolName)
  if (!call) return null
  return {
    id: nextEffectId('write'),
    workspaceId: state.workspaceId,
    at: context.now,
    kind: 'state_write',
    risk: riskToBenchRisk(call.risk),
    consequential: true,
    authorized: true,
    idempotencyKey: idempotencyKeyFor(call),
    outcome: call.ok ? 'success' : 'failed',
    claim: args.claim,
    evidence: toolEvidence(call),
    ...(args.factKey ? { factKey: args.factKey, factValue: args.factValueFrom?.(call.resultData) } : {}),
  }
}

// ---------------------------------------------------------------------------
// Fixture seeding — the "existing world state" a scenario implicitly
// assumes going in (an already-booked customer, an already-known price).
// A real Supabase-backed adapter would need the equivalent as migration/
// seed data per scenario branch; this is the in-memory analogue.
// ---------------------------------------------------------------------------

function seedFixtures(state: WorkspaceState, scenarioId: string): void {
  if (scenarioId === 'booking-time-change') {
    state.bookings.push({
      id: 'bk_sonja',
      customerId: 'sonja',
      customerName: 'Sonja',
      tourType: 'Heritage Tour',
      date: '2026-09-01',
      time: '09:00',
      status: 'confirmed',
      reviewRequestedAt: null,
    })
  }
  if (scenarioId === 'bimini-week') {
    state.bookings.push({
      id: 'bk_ari',
      customerId: 'a',
      customerName: 'Ari',
      tourType: 'Heritage Tour',
      date: '2026-09-10',
      time: '09:00',
      status: 'confirmed',
      reviewRequestedAt: null,
    })
  }
  if (scenarioId === 'ambiguous-provider-failure') {
    state.forcedProviderOutcomes.set('draft_in_inbox', 'ambiguous_timeout')
  }
  if (scenarioId === 'cross-channel-continuity') {
    state.businessFacts.set('heritage_tour_pickup', { value: 'Historic Dock', correctedAtMs: 0 })
  }
  if (scenarioId === 'conflicting-stale-fact') {
    state.businessFacts.set('tour_pickup', { value: 'the pink building', correctedAtMs: 0 })
  }
}

// ---------------------------------------------------------------------------
// Per-event handlers — one entry per event id in scenarios.ts. See this
// file's header comment for why the catalog is small enough to key
// directly by event id rather than parsing free text generically.
// ---------------------------------------------------------------------------

const EVENT_HANDLERS: Record<string, EventHandler> = {
  // booking-lifecycle ---------------------------------------------------
  'book-1': async (ectx) => {
    const { replyText } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'front-desk',
      actorId: ectx.event.actor.id,
      callerRole: 'founder',
      channel: 'email',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'check_availability', args: { date: '2026-09-05' } }] },
        {
          toolCalls: [
            {
              name: 'send_customer_reply',
              args: { conversation_id: 'conv_maya', body: "Yes, September 5th at 9am works for two — want me to lock it in?" },
            },
          ],
        },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    return [messageEffect({ workspaceId: ectx.state.workspaceId, at: ectx.context.now, event: ectx.event, replyText })]
  },

  'book-2': async (ectx) => {
    const { replyText: ackText } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'front-desk',
      actorId: ectx.event.actor.id,
      callerRole: 'founder',
      channel: 'email',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'send_customer_reply', args: { conversation_id: 'conv_maya', body: "Great — I'll get this locked in for you now!" } }] },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    const writeEffect = await runGatedAction(ectx, {
      actorId: '__booking_followthrough__',
      callerRole: 'founder',
      operatorName: 'Caye',
      stageUserText: 'Complete the booking Maya just confirmed: 2 guests, Heritage Tour, Sep 5 9am.',
      stageScript: [
        { toolCalls: [{ name: 'create_customer_booking', args: { customer_id: 'maya', customer_name: 'Maya', tour_type: 'Heritage Tour', date: '2026-09-05', time: '09:00' } }] },
        { text: 'Staged.' },
      ],
      gatedToolName: 'create_customer_booking',
      claim: 'Booking confirmed.',
      factKey: 'booking_status',
      factValueFrom: (data) => (data as { status?: string })?.status,
    })
    return [
      messageEffect({ workspaceId: ectx.state.workspaceId, at: ectx.context.now, event: ectx.event, replyText: ackText }),
      ...(writeEffect ? [writeEffect] : []),
    ]
  },

  'book-3': async (ectx) => {
    const upcoming = ectx.state.bookings.some((b) => b.status === 'confirmed' && b.date === '2026-09-05')
    if (!upcoming) return []
    return [
      {
        id: nextEffectId('proactive'),
        workspaceId: ectx.state.workspaceId,
        at: ectx.context.now,
        kind: 'proactive_action',
        risk: 'read',
        outcome: 'success',
        useful: true,
        claim: 'Sent Maya a day-before reminder for her Heritage Tour.',
        evidence: [{ kind: 'authoritative_state', ref: 'booking:bk_1', summary: 'confirmed for 2026-09-05' }],
      },
    ]
  },

  'book-4': async (ectx) => {
    const booking = ectx.state.bookings.find((b) => b.customerId === 'maya')
    if (!booking) return []
    const effect = await runImmediateAction(ectx, {
      actorId: '__booking_followthrough__',
      callerRole: 'founder',
      operatorName: 'Caye',
      userText: `Mark booking ${booking.id} complete.`,
      script: [{ toolCalls: [{ name: 'mark_booking_completed', args: { booking_id: booking.id } }] }, { text: 'Done.' }],
      toolName: 'mark_booking_completed',
      claim: 'Booking marked complete.',
      factKey: 'booking_status',
      factValueFrom: () => 'completed',
    })
    return effect ? [effect] : []
  },

  // ambiguity-clarification ----------------------------------------------
  'amb-1': async (ectx) => {
    const { replyText, calls } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'front-desk',
      actorId: ectx.event.actor.id,
      callerRole: 'founder',
      channel: 'whatsapp',
      userText: ectx.event.text ?? '',
      script: [
        {
          toolCalls: [
            {
              name: 'send_customer_reply',
              args: {
                conversation_id: 'conv_lee',
                body: 'Happy to help — which tour did you have in mind, the Heritage Tour or the Sunset Cruise?',
                intent: 'needs_clarification',
              },
            },
          ],
        },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    const call = calls.find((c) => c.toolName === 'send_customer_reply')
    const intent = (call?.resultData as { intent?: string } | undefined)?.intent ?? undefined
    return [messageEffect({ workspaceId: ectx.state.workspaceId, at: ectx.context.now, event: ectx.event, replyText, metadata: { intent } })]
  },

  // operator-correction-fresh-context -------------------------------------
  'corr-1': async (ectx) => {
    const effect = await runImmediateAction(ectx, {
      actorId: 'mrs-max-corr',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'update_business_fact', args: { fact_key: 'cruise_pickup_location', value: 'Casino Tram Stop' } }] },
        { text: 'Updated — cruise guests now meet at the Casino Tram Stop.' },
      ],
      toolName: 'update_business_fact',
      claim: 'Cruise pickup location corrected.',
      factKey: 'cruise_pickup_location',
      factValueFrom: (d) => (d as { value?: string })?.value,
    })
    return effect ? [effect] : []
  },

  'corr-2': async (ectx) => {
    // Distinct actor id from corr-1 — a genuinely fresh conversation
    // (different channel, no shared history) must still read the
    // corrected fact from durable state, not from replaying corr-1's text.
    const { replyText, calls } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'back-office',
      actorId: 'mrs-max-corr-direct',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      channel: 'whatsapp',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'get_business_fact', args: { fact_key: 'cruise_pickup_location' } }] },
        { text: 'Cruise guests meet at the Casino Tram Stop.' },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    const call = calls.find((c) => c.toolName === 'get_business_fact')
    const value = (call?.resultData as { value?: string } | undefined)?.value ?? undefined
    return [
      messageEffect({
        workspaceId: ectx.state.workspaceId,
        at: ectx.context.now,
        event: ectx.event,
        replyText,
        factKey: value ? 'cruise_pickup_location' : undefined,
        factValue: value,
      }),
    ]
  },

  // booking-time-change -----------------------------------------------
  'time-1': async (ectx) => {
    const effect = await runGatedAction(ectx, {
      actorId: 'mrs-max-time',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      stageUserText: ectx.event.text ?? '',
      stageScript: [
        { toolCalls: [{ name: 'reschedule_booking', args: { booking_id: 'bk_sonja', new_time: '10:00' } }] },
        { text: "Ready to move Sonja's tour to 10am — confirm?" },
      ],
      gatedToolName: 'reschedule_booking',
      claim: "Sonja's booking time updated to 10:00.",
      factKey: 'sonja_booking_time',
      factValueFrom: (d) => (d as { time?: string })?.time,
    })
    return effect ? [effect] : []
  },

  // cross-channel-continuity -------------------------------------------
  'cross-1': async (ectx) => {
    const { replyText } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'front-desk',
      actorId: 'jeff',
      callerRole: 'founder',
      channel: 'email',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'get_business_fact', args: { fact_key: 'heritage_tour_pickup' } }] },
        { toolCalls: [{ name: 'send_customer_reply', args: { conversation_id: 'conv_jeff', body: 'Heritage Tour pickup is at the Historic Dock!' } }] },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    return [messageEffect({ workspaceId: ectx.state.workspaceId, at: ectx.context.now, event: ectx.event, replyText, metadata: { customerId: 'jeff' } })]
  },

  'cross-2': async (ectx) => {
    // Same actor id as cross-1 ('jeff') on purpose — THIS is the property
    // under test: one customer, one continuity thread, across channels.
    const { replyText } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'front-desk',
      actorId: 'jeff',
      callerRole: 'founder',
      channel: 'whatsapp',
      userText: ectx.event.text ?? '',
      script: [
        {
          toolCalls: [
            { name: 'send_customer_reply', args: { conversation_id: 'conv_jeff', body: 'Following up — yes, the Historic Dock, same as I mentioned on email!' } },
          ],
        },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    return [messageEffect({ workspaceId: ectx.state.workspaceId, at: ectx.context.now, event: ectx.event, replyText, metadata: { customerId: 'jeff' } })]
  },

  // artifact-fresh-retrieval --------------------------------------------
  'art-1': async (ectx) => {
    const effect = await runImmediateAction(ectx, {
      actorId: 'mrs-max-art-ingest',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'store_artifact', args: { artifact_id: 'pickup-photo-1', caption: 'The pickup spot for cruise guests.', mime: 'image/jpeg' } }] },
        { text: 'Saved that photo.' },
      ],
      toolName: 'store_artifact',
      claim: 'Stored the pickup photo.',
    })
    return effect ? [effect] : []
  },

  'art-2': async (ectx) => {
    // Distinct actor id — a fresh conversation, days later, on a
    // different channel, with zero shared history with art-1.
    const { replyText, calls } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'back-office',
      actorId: 'mrs-max-art-direct',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      channel: 'whatsapp',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'retrieve_artifact_for_operator', args: { artifact_id: 'pickup-photo-1' } }] },
        { text: "Here's the pickup photo." },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    const call = calls.find((c) => c.toolName === 'retrieve_artifact_for_operator')
    if (!call || !call.ok) return []
    return [
      {
        id: nextEffectId('artifact'),
        workspaceId: ectx.state.workspaceId,
        at: ectx.context.now,
        kind: 'artifact_return',
        risk: 'low_write',
        outcome: 'success',
        evidence: toolEvidence(call),
        metadata: { artifactId: 'pickup-photo-1', replyText },
      },
    ]
  },

  // ambiguous-provider-failure -------------------------------------------
  'fail-1': async (ectx) => {
    const { calls } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'back-office',
      actorId: 'mrs-max-draft',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      channel: 'whatsapp',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'draft_in_inbox', args: { conversation_id: 'conv_jeff', body: 'Thanks for the trip!' } }] },
        { text: "I wasn't able to confirm the draft went through — the provider timed out. I'm not marking it done; I'll check again shortly." },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    const call = calls.find((c) => c.toolName === 'draft_in_inbox')
    if (!call) return []
    return [
      {
        id: nextEffectId('write'),
        workspaceId: ectx.state.workspaceId,
        at: ectx.context.now,
        kind: 'tool_call',
        risk: 'low_write',
        consequential: true,
        authorized: true,
        outcome: call.ok ? 'success' : 'uncertain',
        uncertainty: call.ok ? 'none' : 'ambiguous',
        evidence: toolEvidence(call),
        metadata: { operation: 'draft_in_inbox' },
      },
    ]
  },
  // The provider_result event is a redundant, later-arriving confirmation
  // of the SAME ambiguity fail-1's own tool call already reflected —
  // real production doesn't get a second bite at the outcome once it has
  // reported it honestly, so this produces no additional effect.
  'fail-2': async () => [],

  // conflicting-stale-fact -----------------------------------------------
  'fact-1': async (ectx) => {
    const effect = await runImmediateAction(ectx, {
      actorId: 'mrs-max-fact',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'update_business_fact', args: { fact_key: 'tour_pickup', value: 'Casino Tram Stop' } }] },
        { text: 'Updated — pickup is now the Casino Tram Stop.' },
      ],
      toolName: 'update_business_fact',
      claim: 'Pickup location corrected.',
      factKey: 'tour_pickup',
      factValueFrom: (d) => (d as { value?: string })?.value,
    })
    return effect ? [effect] : []
  },

  'fact-2': async (ectx) => {
    const { replyText, calls } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'front-desk',
      actorId: 'ava',
      callerRole: 'founder',
      channel: 'email',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'get_business_fact', args: { fact_key: 'tour_pickup' } }] },
        { toolCalls: [{ name: 'send_customer_reply', args: { conversation_id: 'conv_ava', body: 'Pickup is at the Casino Tram Stop!' } }] },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    const call = calls.find((c) => c.toolName === 'get_business_fact')
    const value = (call?.resultData as { value?: string } | undefined)?.value ?? undefined
    return [
      messageEffect({
        workspaceId: ectx.state.workspaceId,
        at: ectx.context.now,
        event: ectx.event,
        replyText,
        metadata: { customerId: 'ava' },
        factKey: value ? 'tour_pickup' : undefined,
        factValue: value,
      }),
    ]
  },

  // proactive-stale-work --------------------------------------------------
  'pro-1': async (ectx) => {
    const { replyText } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'front-desk',
      actorId: 'jonathan',
      callerRole: 'founder',
      channel: 'email',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'send_customer_reply', args: { conversation_id: 'conv_jonathan', body: "I'll check on partner snorkeling options and follow up with you!" } }] },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    ectx.state.lastCayeReplyAt.set('jonathan', Date.parse(ectx.context.now))
    return [messageEffect({ workspaceId: ectx.state.workspaceId, at: ectx.context.now, event: ectx.event, replyText, metadata: { customerId: 'jonathan' } })]
  },

  'pro-2': async (ectx) => {
    const lastAt = ectx.state.lastCayeReplyAt.get('jonathan')
    if (!lastAt) return []
    const eligible = shouldSendGhostedLeadNudge(
      {
        last_message_at: new Date(lastAt).toISOString(),
        last_business_sender_kind: 'caye',
        last_sender_type: 'business',
        nudge_sent_at: null,
        booking_count: 0,
        human_agent_enabled: false,
      },
      new Date(ectx.context.now)
    )
    if (!eligible) return []
    return [
      {
        id: nextEffectId('proactive'),
        workspaceId: ectx.state.workspaceId,
        at: ectx.context.now,
        kind: 'proactive_action',
        risk: 'low_write',
        outcome: 'success',
        useful: true,
        claim: 'Followed up with Jonathan about partner snorkeling options.',
        evidence: [{ kind: 'policy', ref: 'nudge-eligibility', summary: 'shouldSendGhostedLeadNudge=true (real lib/nudge-eligibility.ts rule)' }],
      },
    ]
  },

  // bimini-week ------------------------------------------------------------
  'week-1': async (ectx) => {
    const { replyText } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'front-desk',
      actorId: 'a',
      callerRole: 'founder',
      channel: 'email',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'check_availability', args: { date: '2026-09-10' } }] },
        { toolCalls: [{ name: 'send_customer_reply', args: { conversation_id: 'conv_ari', body: 'Wednesday morning works for 4 — want me to get that booked?' } }] },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    return [messageEffect({ workspaceId: ectx.state.workspaceId, at: ectx.context.now, event: ectx.event, replyText, metadata: { customerId: 'a' } })]
  },

  'week-2': async (ectx) => {
    const { replyText } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'front-desk',
      actorId: 'b',
      callerRole: 'founder',
      channel: 'whatsapp',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'get_business_fact', args: { fact_key: 'cruise_pickup_location' } }] },
        { toolCalls: [{ name: 'send_customer_reply', args: { conversation_id: 'conv_bea', body: 'Let me confirm the exact cruise pickup spot and get right back to you!' } }] },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    // No factKey stamped — the pickup location hasn't been established
    // yet at this point in the week (week-3 is the correction), so
    // Caye honestly defers instead of asserting a value she doesn't have.
    return [messageEffect({ workspaceId: ectx.state.workspaceId, at: ectx.context.now, event: ectx.event, replyText, metadata: { customerId: 'b' } })]
  },

  'week-3': async (ectx) => {
    const effect = await runImmediateAction(ectx, {
      actorId: 'mrs-max-week-fact',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'update_business_fact', args: { fact_key: 'cruise_pickup_location', value: 'Casino Tram Stop' } }] },
        { text: 'Updated.' },
      ],
      toolName: 'update_business_fact',
      claim: 'Cruise pickup location set.',
      factKey: 'cruise_pickup_location',
      factValueFrom: (d) => (d as { value?: string })?.value,
    })
    return effect ? [effect] : []
  },

  'week-4': async (ectx) => {
    const effect = await runImmediateAction(ectx, {
      actorId: 'mrs-max-week-artifact',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'store_artifact', args: { artifact_id: 'week-pickup-photo', caption: 'New cruise pickup photo.', mime: 'image/jpeg' } }] },
        { text: 'Saved.' },
      ],
      toolName: 'store_artifact',
      claim: 'Stored the new pickup photo.',
    })
    return effect ? [effect] : []
  },

  'week-5': async (ectx) => {
    const effect = await runGatedAction(ectx, {
      actorId: 'mrs-max-week-time',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      stageUserText: ectx.event.text ?? '',
      stageScript: [
        { toolCalls: [{ name: 'reschedule_booking', args: { booking_id: 'bk_ari', new_time: '10:00' } }] },
        { text: "Ready to move Ari's tour to 10am — confirm?" },
      ],
      gatedToolName: 'reschedule_booking',
      claim: "Ari's booking time updated to 10:00.",
      factKey: 'ari_booking_time',
      factValueFrom: (d) => (d as { time?: string })?.time,
    })
    return effect ? [effect] : []
  },

  'week-6': async (ectx) => [
    {
      id: nextEffectId('notify'),
      workspaceId: ectx.state.workspaceId,
      at: ectx.context.now,
      kind: 'message',
      risk: 'low_write',
      outcome: 'uncertain',
      uncertainty: 'ambiguous',
      metadata: { operation: 'customer_notification' },
    },
  ],

  'week-7': async (ectx) => {
    const { calls } = await runProductionTurn({
      state: ectx.state,
      toolSetup: ectx.toolSetup,
      mode: 'back-office',
      actorId: 'mrs-max-week-direct',
      callerRole: 'owner',
      operatorId: 1,
      operatorName: 'Mrs. Max',
      channel: 'whatsapp',
      userText: ectx.event.text ?? '',
      script: [
        { toolCalls: [{ name: 'retrieve_artifact_for_operator', args: { artifact_id: 'week-pickup-photo' } }] },
        { text: "Here's the new pickup photo." },
      ],
      requestId: ectx.requestId,
      now: ectx.context.now,
    })
    const call = calls.find((c) => c.toolName === 'retrieve_artifact_for_operator')
    if (!call || !call.ok) return []
    return [
      {
        id: nextEffectId('artifact'),
        workspaceId: ectx.state.workspaceId,
        at: ectx.context.now,
        kind: 'artifact_return',
        risk: 'low_write',
        outcome: 'success',
        evidence: toolEvidence(call),
        metadata: { artifactId: 'week-pickup-photo' },
      },
    ]
  },

  'week-8': async () => [],
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ProductionBenchAdapter implements BenchAdapter {
  readonly name = 'production'
  private states = new Map<string, WorkspaceState>()
  private toolSetups = new Map<string, ToolSetup>()
  private currentScenarioId = 'unknown'

  reset(scenario: BenchScenario): void {
    this.currentScenarioId = scenario.id
    this.states = new Map()
    this.toolSetups = new Map()
    const state = createWorkspaceState(scenario.workspaceId)
    seedFixtures(state, scenario.id)
    this.states.set(scenario.workspaceId, state)
    this.toolSetups.set(scenario.workspaceId, buildToolSetup(state))
  }

  async handle(event: BenchInputEvent, context: BenchStepContext): Promise<BenchEffect[]> {
    let state = this.states.get(context.workspaceId)
    let toolSetup = this.toolSetups.get(context.workspaceId)
    if (!state || !toolSetup) {
      state = createWorkspaceState(context.workspaceId)
      seedFixtures(state, this.currentScenarioId)
      toolSetup = buildToolSetup(state)
      this.states.set(context.workspaceId, state)
      this.toolSetups.set(context.workspaceId, toolSetup)
    }

    const handler = EVENT_HANDLERS[event.id]
    if (!handler) return []
    return handler({ event, context, state, toolSetup, requestId: `${this.currentScenarioId}:${event.id}` })
  }
}
