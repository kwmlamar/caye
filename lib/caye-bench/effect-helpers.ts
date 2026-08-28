import type { Tool, ToolRisk } from '../caye-agent/tools/types'
import type { BenchEffect, BenchEvidence, BenchInputEvent, BenchRisk } from './types'

/**
 * effect-helpers.ts
 *
 * Shared primitives for turning a real tool call's outcome into a
 * `BenchEffect` — extracted from `production-adapter.ts` (Caye Bench v1)
 * so `replay-adapter.ts` (Caye Bench v2) can produce effects the exact
 * same, honest way rather than a second, drifting copy of this logic.
 * Nothing here changed behavior when it moved; see production-adapter.ts's
 * git history for the pre-extraction version if a diff is ever needed.
 */

export interface TurnCallRecord {
  toolName: string
  risk: ToolRisk
  args: unknown
  ok: boolean
  status?: string
  resultData: unknown
  pendingOnly: boolean
  executed: boolean
}

export function outcomeFromResult(data: unknown): { pendingOnly: boolean; executed: boolean } {
  const d = data as Record<string, unknown> | undefined
  const pendingOnly = !!(d && d.pending === true && d.executed === false)
  return { pendingOnly, executed: !pendingOnly }
}

/** Wraps a tool so every call — regardless of which adapter's turn it ran
 *  in — is recorded into `sink` with its real outcome, before any
 *  effect-construction logic ever looks at it. */
export function instrument(tool: Tool<never>, sink: { current: TurnCallRecord[] }): Tool<never> {
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

let effectSeq = 0
export function nextEffectId(prefix: string): string {
  effectSeq += 1
  return `${prefix}-${effectSeq}`
}

export function riskToBenchRisk(r: ToolRisk): BenchRisk {
  return r === 'read' ? 'read' : r === 'high' ? 'high_write' : 'low_write'
}

export function toolEvidence(call: TurnCallRecord): BenchEvidence[] {
  // A failed tool call (ToolResult.ok === false) is not required to carry
  // a `data` field — several fixtures here return only
  // `{ ok: false, error, status, error_code }` on failure, matching the
  // real `ToolResult` shape. JSON.stringify(undefined) returns the
  // (non-string) value `undefined`, not "undefined", so this must not
  // assume `.resultData` is always JSON-stringifiable.
  const summary = call.resultData !== undefined ? JSON.stringify(call.resultData) : `ok=${call.ok} status=${call.status ?? 'n/a'}`
  return [{ kind: 'tool_result', ref: call.toolName, summary: summary.slice(0, 300) }]
}

export function idempotencyKeyFor(call: TurnCallRecord): string {
  return `${call.toolName}:${JSON.stringify(call.args)}`
}

export function messageEffect(args: {
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
