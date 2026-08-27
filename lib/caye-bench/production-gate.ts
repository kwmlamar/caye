import { randomUUID } from 'node:crypto'
import type { Tool, ToolContext, ToolResult } from '../caye-agent/tools/types'
import { stableArgsKey, extractTargetKey } from '../caye-agent/tools/high-risk-gate'

/**
 * production-gate.ts — the production adapter's own high-risk stage/
 * confirm gate.
 *
 * Deliberately NOT `lib/caye-agent/replay/fake-high-risk-gate.ts`, even
 * though it mirrors the same rules and imports the same real
 * `stableArgsKey`/`extractTargetKey` the production `gateHighRisk` uses —
 * that harness wraps REAL PRODUCTION tool objects and must never let a
 * confirmed action actually run (see its own header comment: "this
 * harness's job is to prove that authorization was reached correctly
 * without ever performing the underlying send/booking/mutation").
 *
 * The production adapter's high-risk tools (production-tools.ts) are the
 * inverse situation: safe, in-memory-only fixtures with no real external
 * side effect. A multi-day scenario needs a CONFIRMED action to actually
 * mutate durable state (a booking staged this turn has to still be there,
 * pending, for a later turn to complete) — so this gate calls the real
 * underlying `tool.execute()` on confirmation instead of recording a
 * canned outcome, while reproducing the exact same staging/confirm/
 * supersession/expiry/scan-origin RULES the real gate implements.
 */

interface PendingRow {
  id: string
  toolName: string
  args: unknown
  argsKey: string
  targetKey: string | null
  createdInRequestId: string
  operatorId: number | null
  origin: 'chat' | 'scan' | undefined
  expiresAtMs: number
  executedAt: string | null
  cancelledAt: string | null
  supersededBy: string | null
}

export interface ProductionGateStore {
  rows: PendingRow[]
}

export function createProductionGateStore(): ProductionGateStore {
  return { rows: [] }
}

function isLive(row: PendingRow, nowMs: number): boolean {
  return !row.executedAt && !row.cancelledAt && row.expiresAtMs > nowMs
}

export function wrapWithProductionGate<T>(
  tool: Tool<T>,
  store: ProductionGateStore,
  nowMs: () => number,
  ttlMs: number = 15 * 60 * 1000
): Tool<T> {
  return {
    ...tool,
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const now = nowMs()
      const argsKey = stableArgsKey(args)
      const operatorId = ctx.operatorId ?? null

      const liveExisting = store.rows.find(
        (r) => r.toolName === tool.name && r.argsKey === argsKey && r.operatorId === operatorId && isLive(r, now)
      )
      if (liveExisting) {
        if (liveExisting.createdInRequestId !== ctx.requestId && ctx.origin !== 'scan') {
          liveExisting.executedAt = new Date(now).toISOString()
          return tool.execute(args, ctx)
        }
        return {
          ok: true,
          data: { pending: true, executed: false, pending_action_id: liveExisting.id, note: 'NOTHING HAS HAPPENED YET.' },
        }
      }

      const pendingActionId = randomUUID()
      const targetKey = extractTargetKey(args as Record<string, unknown>)
      if (targetKey) {
        for (const row of store.rows) {
          if (row.toolName === tool.name && row.operatorId === operatorId && row.targetKey === targetKey && isLive(row, now)) {
            row.cancelledAt = new Date(now).toISOString()
            row.supersededBy = pendingActionId
          }
        }
      }

      store.rows.push({
        id: pendingActionId,
        toolName: tool.name,
        args,
        argsKey,
        targetKey,
        createdInRequestId: ctx.requestId,
        operatorId,
        origin: ctx.origin,
        expiresAtMs: now + ttlMs,
        executedAt: null,
        cancelledAt: null,
        supersededBy: null,
      })

      return {
        ok: true,
        data: {
          pending: true,
          executed: false,
          pending_action_id: pendingActionId,
          note: 'NOTHING HAS BEEN SENT OR CHANGED YET. Confirm in a separate call to execute it.',
        },
      }
    },
  }
}

export function makeProductionConfirmTool(
  store: ProductionGateStore,
  underlyingTools: Map<string, Tool<never>>,
  nowMs: () => number
): Tool<{ pending_action_id: string }> {
  return {
    name: 'confirm_pending_action',
    description: 'Execute an action you already staged, once authorized.',
    risk: 'high',
    roles: ['owner', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: { pending_action_id: { type: 'string' } },
      required: ['pending_action_id'],
    },
    async execute(args, ctx) {
      const row = store.rows.find((r) => r.id === args.pending_action_id)
      if (!row) return { ok: false, error: 'No staged action with that id.' }
      if (row.executedAt) return { ok: false, error: 'Already executed.' }
      if (row.cancelledAt) {
        return row.supersededBy
          ? { ok: false, error: `Superseded by ${row.supersededBy} — confirm that id instead.` }
          : { ok: false, error: 'That action was cancelled.' }
      }
      if (row.expiresAtMs <= nowMs()) return { ok: false, error: 'That staged action expired before it was confirmed.' }
      if (row.createdInRequestId === ctx.requestId) return { ok: false, error: 'Staged this turn — needs a new request to confirm.' }
      const tool = underlyingTools.get(row.toolName)
      if (!tool) return { ok: false, error: `Unknown staged tool: ${row.toolName}` }

      row.executedAt = new Date(nowMs()).toISOString()
      const result = await tool.execute(row.args as never, ctx)
      return { ...result, data: { ...((result.data as object) ?? {}), confirmed_tool_name: row.toolName, pending_action_id: row.id } }
    },
  }
}
