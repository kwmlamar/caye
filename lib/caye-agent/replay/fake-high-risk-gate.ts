import { randomUUID } from 'node:crypto'
import type { Tool, ToolContext, ToolResult } from '../tools/types'
import { stableArgsKey, extractTargetKey } from '../tools/high-risk-gate'
import type { DryRunCollector } from '../tools/dry-run'

/**
 * replay/fake-high-risk-gate.ts
 *
 * PHASE 3 — a DB-free test double for `gateHighRisk`
 * (lib/caye-agent/tools/high-risk-gate.ts), for the whole-job replay
 * harness (Part F/G). Not used by, or reachable from, any production code
 * path.
 *
 * WHY THIS EXISTS RATHER THAN CALLING THE REAL GATE
 * The real `gateHighRisk` talks to `caye_pending_actions` via
 * `createServiceClient()` directly — there's no way to inject a fake store
 * into it, and pointing a whole-job replay at the REAL table (even for a
 * real workspace, even though the final send is dry-run) would still be a
 * genuine write against production infrastructure, which every phase of
 * this convergence work has been explicit is off-limits. `wrapToolsForDryRun`
 * (dry-run.ts) can't substitute either — it REPLACES a tool's execute()
 * outright, which would erase gateHighRisk's stage/confirm mechanic
 * entirely rather than exercise it; Scenario A's whole point (Part G #14)
 * is proving that mechanic — including the Part E supersession logic —
 * actually works across turns, not proving something dry-run stubbed out.
 *
 * WHAT THIS MIRRORS, ON PURPOSE, NOT BY ACCIDENT
 * The exact observable contract of the real gate: `stableArgsKey` and
 * `extractTargetKey` are IMPORTED from high-risk-gate.ts, not
 * reimplemented, so this can never silently drift from what production
 * actually matches on. The staging/confirm/operator-scoping/scan-origin/
 * supersession/expiry RULES are reproduced here (that part IS duplicated —
 * an in-memory Map standing in for a Postgres table has no other way to
 * exist) but the DECISION LOGIC that makes those rules meaningful stays
 * imported, not copied.
 *
 * The one deliberate behavioral difference: on the confirming call, this
 * records a `ProposedAction` into the supplied `DryRunCollector` instead
 * of calling the wrapped tool's real `execute()` — the real gate's job
 * ends at "authorized to run"; this harness's job is to prove that
 * authorization was reached correctly without ever performing the
 * underlying send/booking/mutation, live model or not.
 */

interface FakePendingRow {
  id: string
  toolName: string
  args: unknown
  argsKey: string
  targetKey: string | null
  summary: string
  createdInRequestId: string
  operatorId: number | null
  origin: 'chat' | 'scan' | undefined
  expiresAtMs: number
  executedAt: string | null
  cancelledAt: string | null
  supersededBy: string | null
}

export interface FakePendingActionsStore {
  rows: FakePendingRow[]
}

export function createFakePendingActionsStore(): FakePendingActionsStore {
  return { rows: [] }
}

function summarize(toolName: string, args: unknown): string {
  const a = args as Record<string, unknown>
  if (toolName === 'send_reply' || toolName === 'send_customer_reply') {
    return `Send:\n\n${typeof a.body === 'string' ? a.body : ''}`
  }
  return `Run ${toolName}`
}

function isLive(row: FakePendingRow, nowMs: number): boolean {
  return !row.executedAt && !row.cancelledAt && row.expiresAtMs > nowMs
}

export function wrapWithFakeHighRiskGate<T>(
  tool: Tool<T>,
  store: FakePendingActionsStore,
  collector: DryRunCollector,
  ttlMs: number = 15 * 60 * 1000
): Tool<T> {
  return {
    ...tool,
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const nowMs = Date.now()
      const argsKey = stableArgsKey(args)
      const operatorId = ctx.operatorId ?? null
      const summary = summarize(tool.name, args)

      const liveExisting = store.rows.find(
        (r) => r.toolName === tool.name && r.argsKey === argsKey && r.operatorId === operatorId && isLive(r, nowMs)
      )

      if (liveExisting) {
        if (liveExisting.createdInRequestId !== ctx.requestId && ctx.origin !== 'scan') {
          liveExisting.executedAt = new Date().toISOString()
          collector.proposedActions.push({
            toolName: tool.name,
            risk: tool.risk,
            args,
            recordedAt: liveExisting.executedAt,
          })
          return { ok: true, data: { sent: true, dry_run: true, proposed: true } }
        }
        return {
          ok: true,
          data: {
            pending: true,
            executed: false,
            status: 'awaiting_operator_confirmation',
            pending_action_id: liveExisting.id,
            summary,
            note: 'NOTHING HAS HAPPENED YET.',
          },
        }
      }

      const pendingActionId = randomUUID()
      const targetKey = extractTargetKey(args as Record<string, unknown>)
      if (targetKey) {
        for (const row of store.rows) {
          if (row.toolName === tool.name && row.operatorId === operatorId && row.targetKey === targetKey && isLive(row, nowMs)) {
            row.cancelledAt = new Date().toISOString()
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
        summary,
        createdInRequestId: ctx.requestId,
        operatorId,
        origin: ctx.origin,
        expiresAtMs: nowMs + ttlMs,
        executedAt: null,
        cancelledAt: null,
        supersededBy: null,
      })

      return {
        ok: true,
        data: {
          pending: true,
          executed: false,
          status: 'awaiting_operator_confirmation',
          pending_action_id: pendingActionId,
          summary,
          note:
            'NOTHING HAS BEEN SENT OR CHANGED YET. Relay this summary and ask ONE confirmation ' +
            'question. When approved in a NEW message, call confirm_pending_action.',
        },
      }
    },
  }
}

/**
 * Fake `confirm_pending_action` — resolves a staged row by id against the
 * same in-memory store, mirroring write-high/confirm-pending-action.ts's
 * checks (found / not executed / not cancelled / not expired / different
 * request) without touching Supabase.
 */
export function makeFakeConfirmPendingAction(
  store: FakePendingActionsStore,
  collector: DryRunCollector,
  underlyingTools: Map<string, Tool<never>>
): Tool<{ pending_action_id: string }> {
  return {
    name: 'confirm_pending_action',
    description: 'Execute an action you already staged, once the operator has approved it.',
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
      if (row.expiresAtMs <= Date.now()) {
        return { ok: false, error: 'That staged action expired before it was confirmed.' }
      }
      if (row.createdInRequestId === ctx.requestId) {
        return { ok: false, error: 'Staged this turn — needs a new message to confirm.' }
      }
      const tool = underlyingTools.get(row.toolName)
      if (!tool) return { ok: false, error: `Unknown staged tool: ${row.toolName}` }

      row.executedAt = new Date().toISOString()
      collector.proposedActions.push({
        toolName: row.toolName,
        risk: tool.risk,
        args: row.args,
        recordedAt: row.executedAt,
      })
      return { ok: true, data: { sent: true, dry_run: true, proposed: true } }
    },
  }
}
