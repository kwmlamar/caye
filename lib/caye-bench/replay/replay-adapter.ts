import type Anthropic from '@anthropic-ai/sdk'
import { loadAttentionDelta, renderAttentionContext } from '../../owner-attention'
import { shouldSendGhostedLeadNudge, shouldSendReviewRequest } from '../../nudge-eligibility'
import { createWorkspaceState, type WorkspaceState } from '../production-state'
import { buildToolSetup, type ToolSetup } from '../tool-setup'
import { runProductionTurn } from '../turn-runner'
import { messageEffect, nextEffectId, riskToBenchRisk, toolEvidence, idempotencyKeyFor, type TurnCallRecord } from '../effect-helpers'
import type { BenchAdapter, BenchEffect, BenchInputEvent, BenchStepContext } from '../types'
import type { BenchModelRound } from '../model-double'
import { seedWorkspaceStateFromTrace } from './state-seed'
import { attentionDouble } from './attention-double'
import type { ReplayTrace } from './types'

/**
 * replay/replay-adapter.ts
 *
 * Caye Bench v2's real-Caye adapter for RECORDED HISTORY, as opposed to
 * v1's `ProductionBenchAdapter` (a fixed, hand-scripted catalog). Shares
 * `tool-setup.ts` / `turn-runner.ts` / `effect-helpers.ts` with v1 —
 * same real tool registry, same real high-risk gate, same real prompt
 * builders, same real `runToolLoop` — but dispatches GENERICALLY by
 * event kind/actor role instead of a per-event-id script table, because a
 * replay trace's events are arbitrary reconstructed history, not a fixed
 * 26-event catalog a human wrote by hand.
 *
 * GENERIC vs SCRIPTED, and why that's safe here in a way it wasn't for v1
 * `production-adapter.ts`'s header comment explains why v1 scripts every
 * turn: a generic adapter needs the model to reason for real, which is
 * non-deterministic and needs live credentials. v2 accepts exactly that
 * trade for message/correction turns — replay's entire point is "what
 * would CURRENT Caye actually decide", which a hand-written script can't
 * answer. What stays deterministic regardless: `timer` / `provider_result`
 * / `state_change` / `artifact` events are handled by CODE, not the
 * model (proactive eligibility reuses the real, pure
 * `shouldSendGhostedLeadNudge` / `shouldSendReviewRequest`), and the
 * model seam (`loggedMessagesCreate`) is swappable between a real live
 * call (`model-double.ts`'s `liveModelRunner`) and a deterministic script
 * (`scriptedRounds`) without this file knowing which is active — see
 * replay/cli-runner.test.ts for how each mode wires it.
 *
 * SAFETY: this adapter never calls `createServiceClient` itself for
 * booking/fact/artifact data — that's isolated `WorkspaceState`
 * (production-state.ts), same as v1. It DOES call the real
 * `loadAttentionDelta` (lib/owner-attention.ts) when a trace carries
 * attention seed data, which internally calls `createServiceClient()` —
 * every caller of this adapter (tests AND the CLI) MUST mock
 * `@/lib/supabase-server` to `replay/attention-fake.ts`'s isolated table,
 * never leave it pointed at real Supabase. See cli-runner.test.ts's own
 * header comment for how that guarantee is enforced structurally, not by
 * convention.
 */

export interface BenchReplayAdapterOptions {
  client?: Anthropic
  model?: string
  maxTokens?: number
  name?: string
  businessName?: string
  /**
   * Per-event-id scripted model rounds — an ESCAPE HATCH for deterministic
   * offline self-tests (`replay/cli-runner.test.ts`'s default, CI-safe
   * suite), never used by a genuine live replay run. When an event's id
   * has an entry here, that turn follows the script instead of letting
   * the model reason for real — same mechanism v1's `ProductionBenchAdapter`
   * uses for every turn (`turn-runner.ts`'s `script` param), just opt-in
   * per event here instead of mandatory for all of them.
   */
  turnScripts?: Record<string, BenchModelRound[]>
}

const DEFAULT_MODEL = 'claude-sonnet-4-6'

function toFrontDeskChannel(channel: BenchInputEvent['channel']): 'whatsapp' | 'instagram' | 'messenger' | 'email' {
  return channel === 'email' || channel === 'whatsapp' ? channel : 'whatsapp'
}

export class BenchReplayAdapter implements BenchAdapter {
  readonly name: string
  private readonly trace: ReplayTrace
  private readonly client: Anthropic
  private readonly model: string
  private readonly maxTokens: number
  private readonly turnScripts: Record<string, BenchModelRound[]>
  private state!: WorkspaceState
  private toolSetup!: ToolSetup

  constructor(trace: ReplayTrace, opts: BenchReplayAdapterOptions = {}) {
    this.trace = trace
    this.client = opts.client ?? ({} as never)
    this.model = opts.model ?? DEFAULT_MODEL
    this.maxTokens = opts.maxTokens ?? 1024
    this.turnScripts = opts.turnScripts ?? {}
    this.name = opts.name ?? `replay:${trace.traceId}`
  }

  reset(): void {
    this.state = createWorkspaceState(this.trace.workspaceId)
    seedWorkspaceStateFromTrace(this.state, this.trace)
    this.toolSetup = buildToolSetup(this.state)
    attentionDouble.current = (this.trace.seed.attentionItems ?? []).slice()
  }

  async handle(event: BenchInputEvent, context: BenchStepContext): Promise<BenchEffect[]> {
    switch (event.kind) {
      case 'timer':
        return this.handleTimer(event, context)
      case 'provider_result':
        return this.handleProviderResult()
      case 'state_change':
        return this.handleStateChange(event, context)
      case 'artifact':
        return this.handleArtifactIngest(event, context)
      case 'message':
      case 'correction':
        return event.actor.role === 'customer' ? this.handleCustomerTurn(event, context) : this.handleOperatorTurn(event, context)
      default:
        return []
    }
  }

  // -- message/correction turns: the model reasons for real -------------

  private async handleCustomerTurn(event: BenchInputEvent, context: BenchStepContext): Promise<BenchEffect[]> {
    const { replyText, calls } = await runProductionTurn({
      state: this.state,
      toolSetup: this.toolSetup,
      mode: 'front-desk',
      actorId: event.actor.id,
      callerRole: 'founder',
      channel: toFrontDeskChannel(event.channel),
      userText: event.text ?? '',
      script: this.turnScripts[event.id],
      requestId: `${this.trace.traceId}:${event.id}`,
      now: context.now,
      client: this.client,
      model: this.model,
      maxTokens: this.maxTokens,
      businessName: this.trace.businessName,
      timezone: this.trace.timezone,
    })
    return this.callsToEffects(event, context, calls, replyText)
  }

  private async handleOperatorTurn(event: BenchInputEvent, context: BenchStepContext): Promise<BenchEffect[]> {
    const attentionContext = await this.renderAttentionContextIfSeeded(context)
    const { replyText, calls } = await runProductionTurn({
      state: this.state,
      toolSetup: this.toolSetup,
      mode: 'back-office',
      actorId: event.actor.id,
      callerRole: event.actor.role === 'staff' ? 'staff' : 'owner',
      operatorId: 1,
      operatorName: event.actor.name ?? 'Operator',
      channel: 'whatsapp',
      userText: event.text ?? '',
      script: this.turnScripts[event.id],
      requestId: `${this.trace.traceId}:${event.id}`,
      now: context.now,
      client: this.client,
      model: this.model,
      maxTokens: this.maxTokens,
      businessName: this.trace.businessName,
      timezone: this.trace.timezone,
      attentionContext,
    })
    return this.callsToEffects(event, context, calls, replyText)
  }

  private async renderAttentionContextIfSeeded(context: BenchStepContext): Promise<string | null> {
    if (!this.trace.seed.attentionItems) return null
    const delta = await loadAttentionDelta({ workspaceId: context.workspaceId })
    return renderAttentionContext(delta)
  }

  /** Turns whatever the model actually did this turn into effects — the
   *  generic counterpart to v1's per-event hand-built effect objects.
   *  One effect per consequential/pending tool call, plus one message
   *  effect for the reply itself. */
  private callsToEffects(event: BenchInputEvent, context: BenchStepContext, calls: TurnCallRecord[], replyText: string): BenchEffect[] {
    const effects: BenchEffect[] = []
    let factKey: string | undefined
    let factValue: string | undefined

    for (const call of calls) {
      if (call.toolName === 'get_business_fact') {
        const data = call.resultData as { value?: string | null } | undefined
        if (data?.value != null) {
          const args = call.args as { fact_key?: string }
          factKey = args.fact_key
          factValue = data.value
        }
        continue
      }
      if (call.toolName === 'confirm_pending_action') {
        const data = call.resultData as { confirmed_tool_name?: string } | undefined
        effects.push({
          id: nextEffectId('write'),
          workspaceId: this.state.workspaceId,
          at: context.now,
          kind: 'state_write',
          risk: riskToBenchRisk(call.risk),
          consequential: true,
          authorized: true,
          idempotencyKey: idempotencyKeyFor(call),
          outcome: call.ok ? 'success' : 'failed',
          evidence: toolEvidence(call),
          metadata: { tool: data?.confirmed_tool_name ?? call.toolName, eventId: event.id },
        })
        continue
      }
      if (call.pendingOnly) {
        effects.push({
          id: nextEffectId('escalation'),
          workspaceId: this.state.workspaceId,
          at: context.now,
          kind: 'escalation',
          risk: riskToBenchRisk(call.risk),
          outcome: 'success',
          operatorInterruption: true,
          claim: `Asked to confirm: ${call.toolName}`,
          evidence: toolEvidence(call),
          metadata: { tool: call.toolName, eventId: event.id },
        })
        continue
      }
      if (call.risk === 'read') continue
      // Every consequential attempt gets an effect, success or not — a
      // FAILED or AMBIGUOUS outcome is exactly the information the
      // hard-invariant gate and the historical comparison need to see,
      // not something to silently drop. `call.executed` (true only when
      // `result.ok`) previously gated this block, which meant a failed
      // tool call produced NO effect at all — invisible to
      // false_success_after_ambiguous_failure and to the
      // failedConsequentialActions/ungroundedClaims quality metrics.
      effects.push({
        id: nextEffectId('write'),
        workspaceId: this.state.workspaceId,
        at: context.now,
        kind: call.toolName === 'retrieve_artifact_for_operator' ? 'artifact_return' : 'state_write',
        risk: riskToBenchRisk(call.risk),
        consequential: true,
        authorized: true,
        idempotencyKey: idempotencyKeyFor(call),
        outcome: call.ok ? 'success' : call.status === 'NEEDS_HUMAN' ? 'uncertain' : 'failed',
        uncertainty: !call.ok && call.status === 'NEEDS_HUMAN' ? 'ambiguous' : 'none',
        evidence: toolEvidence(call),
        metadata: { tool: call.toolName, eventId: event.id },
      })
    }

    if (replyText.trim().length > 0) {
      effects.push(messageEffect({ workspaceId: this.state.workspaceId, at: context.now, event, replyText, factKey, factValue }))
    }
    return effects
  }

  // -- deterministic, code-driven events ---------------------------------

  private handleTimer(event: BenchInputEvent, context: BenchStepContext): BenchEffect[] {
    const purpose = (event.data as { purpose?: string } | undefined)?.purpose
    const now = new Date(context.now)

    if (purpose === 'stale_work_scan') {
      const effects: BenchEffect[] = []
      for (const [actorId, lastMs] of this.state.lastCayeReplyAt) {
        const eligible = shouldSendGhostedLeadNudge(
          {
            last_message_at: new Date(lastMs).toISOString(),
            last_business_sender_kind: 'caye',
            last_sender_type: 'business',
            nudge_sent_at: null,
            booking_count: this.state.bookings.filter((b) => b.customerId === actorId).length,
            human_agent_enabled: false,
          },
          now
        )
        if (!eligible) continue
        effects.push({
          id: nextEffectId('proactive'),
          workspaceId: this.state.workspaceId,
          at: context.now,
          kind: 'proactive_action',
          risk: 'low_write',
          outcome: 'success',
          useful: true,
          claim: `Followed up on stale thread with ${actorId}.`,
          evidence: [{ kind: 'policy', ref: 'nudge-eligibility', summary: 'shouldSendGhostedLeadNudge=true (real lib/nudge-eligibility.ts rule)' }],
          metadata: { eventId: event.id, actorId },
        })
      }
      return effects
    }

    if (purpose === 'day_before_reminder' || purpose === 'review_request_scan') {
      const effects: BenchEffect[] = []
      for (const booking of this.state.bookings) {
        if (booking.status !== 'completed' || booking.reviewRequestedAt || !booking.date) continue
        const eligible = shouldSendReviewRequest({ booking_date: booking.date, status: booking.status, review_requested_at: booking.reviewRequestedAt }, now)
        if (!eligible) continue
        booking.reviewRequestedAt = context.now
        effects.push({
          id: nextEffectId('proactive'),
          workspaceId: this.state.workspaceId,
          at: context.now,
          kind: 'proactive_action',
          risk: 'low_write',
          outcome: 'success',
          useful: true,
          claim: `Sent a review request for booking ${booking.id}.`,
          evidence: [{ kind: 'policy', ref: 'nudge-eligibility', summary: 'shouldSendReviewRequest=true (real lib/nudge-eligibility.ts rule)' }],
          metadata: { eventId: event.id, bookingId: booking.id },
        })
      }
      return effects
    }

    return []
  }

  // A provider_result event's outcome must be pre-registered on
  // ReplaySeed.forcedProviderOutcomes (see types.ts's field doc) so the
  // triggering tool call — which already ran, earlier, synchronously —
  // could see it. By the time this event replays, there is nothing left
  // to do; it exists in `events` only for the historical record.
  private handleProviderResult(): BenchEffect[] {
    return []
  }

  private handleStateChange(event: BenchInputEvent, context: BenchStepContext): BenchEffect[] {
    const data = event.data as { bookingId?: string; bookingStatus?: string } | undefined
    if (!data?.bookingStatus) return []
    const booking = data.bookingId
      ? this.state.bookings.find((b) => b.id === data.bookingId)
      : this.state.bookings.find((b) => b.customerId === event.actor.id)
    if (!booking) return []
    booking.status = data.bookingStatus as typeof booking.status
    return [
      {
        id: nextEffectId('write'),
        workspaceId: this.state.workspaceId,
        at: context.now,
        kind: 'state_write',
        risk: 'low_write',
        consequential: true,
        authorized: true,
        outcome: 'success',
        factKey: 'booking_status',
        factValue: data.bookingStatus,
        evidence: [{ kind: 'authoritative_state', ref: `booking:${booking.id}`, summary: `status=${data.bookingStatus}` }],
        metadata: { eventId: event.id, bookingId: booking.id },
      },
    ]
  }

  private handleArtifactIngest(event: BenchInputEvent, context: BenchStepContext): BenchEffect[] {
    const data = event.data as { artifactId?: string; mime?: string } | undefined
    if (!data?.artifactId) return []
    this.state.artifacts.set(data.artifactId, { caption: event.text ?? '', mime: data.mime ?? 'application/octet-stream', storedAtMs: Date.parse(context.now) })
    return [
      {
        id: nextEffectId('write'),
        workspaceId: this.state.workspaceId,
        at: context.now,
        kind: 'state_write',
        risk: 'low_write',
        consequential: true,
        authorized: true,
        outcome: 'success',
        evidence: [{ kind: 'artifact', ref: data.artifactId }],
        metadata: { eventId: event.id, artifactId: data.artifactId },
      },
    ]
  }
}
