import type Anthropic from '@anthropic-ai/sdk'
import { runToolLoop } from '../caye-agent/execute'
import type { Role, ToolMode } from '../caye-agent/tools/types'
import { buildBackOfficeSystemPrompt } from '../caye-agent/modes/back-office'
import { buildFrontDeskSituationSystemPrompt } from '../caye-agent/modes/front-desk-situation'
import { buildSyntheticSituation } from '../caye-agent/replay/fixtures/helpers'
import { modelDouble, scriptedRounds, type BenchModelRound } from './model-double'
import { historyFor, rawTurnsFor, type WorkspaceState } from './production-state'
import type { ToolSetup } from './tool-setup'
import type { TurnCallRecord } from './effect-helpers'

/**
 * turn-runner.ts
 *
 * The one real-execution-path turn runner both Caye Bench adapters share —
 * extracted from `production-adapter.ts` (v1) so `replay-adapter.ts` (v2)
 * drives the exact same production code (`runToolLoop`, the real prompt
 * builders, the real front-desk situation machinery) rather than a second,
 * possibly-drifting copy.
 *
 * The one thing v2 needed that v1 never did: a turn where the MODEL
 * reasons for real instead of following a hand-written script. `script`
 * is now optional — v1's ~20 call sites all still pass one (unchanged
 * behavior, byte-for-byte); when it's omitted, `runProductionTurn` does
 * NOT touch `modelDouble` at all, so whatever `loggedMessagesCreate`
 * currently resolves to runs untouched: the real Anthropic SDK outside a
 * test (a genuine "what would Caye do" replay), or a caller-scripted
 * response inside one. Nothing about the turn's own mechanics changes
 * either way — same tool loop, same gate, same grounding backstop.
 */

export interface RunTurnArgs {
  state: WorkspaceState
  toolSetup: ToolSetup
  mode: ToolMode
  actorId: string
  callerRole: Role
  operatorId?: number | null
  operatorName?: string
  channel: 'whatsapp' | 'instagram' | 'messenger' | 'email'
  userText: string
  /** Omit for a turn where the model must reason for real (v2 replay);
   *  supply for a deterministic, hand-scripted turn (v1 canonical
   *  scenarios, and v2's own offline self-tests). */
  script?: BenchModelRound[]
  requestId: string
  now: string
  /** Real Anthropic client — required only when `script` is omitted AND
   *  `loggedMessagesCreate` is unmocked (i.e. a genuine live replay run).
   *  Tests that omit `script` still pass `{} as never` here because they
   *  mock `loggedMessagesCreate` at the module level instead. */
  client?: Anthropic
  model?: string
  maxTokens?: number
  businessName?: string
  timezone?: string
  /** Pre-rendered attention-delta string — the caller's job to produce
   *  (typically `renderAttentionContext(await loadAttentionDelta(...))`,
   *  see replay/attention-fake.ts for how v2 wires the real functions
   *  against isolated seed data) since owner-attention specifics don't
   *  belong in this generic turn runner. Back-office only; ignored for
   *  front-desk turns, matching `buildBackOfficeSystemPrompt`'s own
   *  `attentionContext` field. */
  attentionContext?: string | null
}

const DEFAULT_BUSINESS_NAME = 'Bimini Bench Tours'
const DEFAULT_TIMEZONE = 'America/Nassau'
const DEFAULT_MODEL = 'caye-bench-fake-model'

export async function runProductionTurn(args: RunTurnArgs): Promise<{ replyText: string; calls: TurnCallRecord[]; ranOutOfIterations?: boolean }> {
  const businessName = args.businessName ?? DEFAULT_BUSINESS_NAME
  const timezone = args.timezone ?? DEFAULT_TIMEZONE
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
      timezone,
    })
    systemPrompt = buildFrontDeskSituationSystemPrompt({ businessName, channel: args.channel, situation, toolsOffered: true })
    initialMessages = situation.historyForModel
  } else {
    const history = historyFor(args.state, args.actorId)
    history.push({ role: 'user', content: args.userText })
    systemPrompt = buildBackOfficeSystemPrompt({
      profile: { operatorName: args.operatorName ?? 'Operator', businessName },
      caller: { role: args.callerRole, name: args.operatorName ?? 'Operator' },
      attentionContext: args.attentionContext,
    })
    initialMessages = history
  }

  if (args.script) modelDouble.current = scriptedRounds(args.script)

  const result = await runToolLoop({
    client: args.client ?? ({} as never),
    model: args.model ?? DEFAULT_MODEL,
    maxTokens: args.maxTokens ?? 1024,
    systemPrompt,
    initialMessages,
    ctx: {
      workspaceId: args.state.workspaceId,
      callerRole: args.callerRole,
      operatorId: args.operatorId ?? null,
      requestId: args.requestId,
      origin: 'chat',
      workspaceTimezone: timezone,
    },
    mode: args.mode,
    tools: args.toolSetup.tools,
  })

  if (args.mode === 'front-desk') {
    rawTurnsFor(args.state, args.actorId).push({ role: 'assistant', content: result.replyText, at: args.now })
  } else {
    historyFor(args.state, args.actorId).push(...result.newTurns)
  }

  return { replyText: result.replyText, calls: args.toolSetup.callSink.current.slice(before), ranOutOfIterations: result.ranOutOfIterations }
}

/**
 * Confirms an already-staged high-risk action from a genuinely SEPARATE
 * request (a real, distinct `runToolLoop` invocation, not a second round
 * of the same one) — the exact discontinuity the real gate requires —
 * without polluting any actor's visible conversation history, since this
 * represents Caye's own internal operational follow-through rather than a
 * turn a human would see repeated back to them.
 */
export async function runInternalConfirm(args: {
  state: WorkspaceState
  toolSetup: ToolSetup
  callerRole: Role
  operatorId?: number | null
  requestId: string
  pendingActionId: string
  timezone?: string
}): Promise<{ calls: TurnCallRecord[] }> {
  const before = args.toolSetup.callSink.current.length
  modelDouble.current = scriptedRounds([
    { toolCalls: [{ name: 'confirm_pending_action', args: { pending_action_id: args.pendingActionId } }] },
    { text: 'Done.' },
  ])
  await runToolLoop({
    client: {} as never,
    model: DEFAULT_MODEL,
    maxTokens: 256,
    systemPrompt: 'You are Caye, completing an already-authorized operational action.',
    initialMessages: [{ role: 'user', content: 'Proceed.' }],
    ctx: {
      workspaceId: args.state.workspaceId,
      callerRole: args.callerRole,
      operatorId: args.operatorId ?? null,
      requestId: args.requestId,
      origin: 'chat',
      workspaceTimezone: args.timezone ?? DEFAULT_TIMEZONE,
    },
    mode: 'back-office',
    tools: args.toolSetup.tools,
  })
  return { calls: args.toolSetup.callSink.current.slice(before) }
}
