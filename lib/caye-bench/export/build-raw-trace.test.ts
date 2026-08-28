import { describe, expect, it, vi } from 'vitest'

// `args-key.ts` imports `stableArgsKey` from `high-risk-gate.ts`, which
// itself starts with `import 'server-only'` — importing the FILE (even
// just for one pure helper) pulls that guard in too. Same mock every
// other Caye Bench test file that touches this import chain already uses
// (production-adapter.test.ts, cli-runner.test.ts, corpus-runner.test.ts).
vi.mock('server-only', () => ({}))

import { buildRawTrace } from './build-raw-trace'
import { sanitizeRawTrace } from '../replay/sanitize'
import { hashArgsObject } from './args-key'
import { BenchInvariantGate } from '../gate'
import type { RawExportBundle } from './types'

/**
 * export/build-raw-trace.test.ts
 *
 * Regression coverage for the authorization-reconstruction fix: a
 * `caye_tool_calls` row's mere existence does NOT prove a high-risk
 * action was authorized+executed (see build-raw-trace.ts's header
 * comment and `resolveHighRiskAuthorization`'s doc comment for the full
 * rationale — a staged-but-never-confirmed high-risk call produces a row
 * with `status:'SUCCESS'` indistinguishable from a real execution unless
 * cross-referenced against `caye_pending_actions.executed_at`), AND for
 * the follow-up fix: correlation must be UNIQUE per call (via
 * `argsKeyHash`/`operatorId`, reusing production's own `stableArgsKey`),
 * not just same-tool matching — otherwise one customer's genuinely
 * executed action could wrongly "prove" authorization for a completely
 * different customer's never-confirmed call to the same tool.
 */

function baseBundle(overrides: Partial<RawExportBundle>): RawExportBundle {
  return {
    selector: { kind: 'consequential-action', workspaceId: 'ws-1', requestId: 'req-1' },
    workspace: { id: 'ws-1', business_name: 'Test Business', timezone: 'America/Nassau' },
    operators: [],
    conversations: [],
    messages: [],
    operatorMessages: [],
    toolCalls: [],
    pendingActions: [],
    bookings: [],
    businessFacts: [],
    operatorLearningAudit: [],
    attentionItems: [],
    artifacts: [],
    artifactObservations: [],
    capturedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  }
}

function effectsFor(bundle: RawExportBundle) {
  const raw = buildRawTrace(bundle, { sourceDescription: 'test' })
  const trace = sanitizeRawTrace(raw, { traceId: 'build-raw-trace-test', salt: 'not-a-secret-test-salt' })
  return trace.historicalEffects
}

function effectFor(bundle: RawExportBundle) {
  const effects = effectsFor(bundle)
  expect(effects.length).toBe(1)
  return effects[0]
}

const argsA = hashArgsObject({ body: 'hi customer A', link: 'https://pay.example/a' })
const argsB = hashArgsObject({ body: 'hi customer B', link: 'https://pay.example/b' })

describe('build-raw-trace.ts — historical authorization reconstruction', () => {
  it('read/low-risk tool calls stay authorized:true (role gate blocks unauthorized calls before a row can exist)', () => {
    const bundle = baseBundle({
      toolCalls: [
        {
          id: 'tc-1',
          workspace_id: 'ws-1',
          request_id: 'req-1',
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'get_business_fact',
          risk: 'read',
          status: 'SUCCESS',
          error_code: null,
          error: null,
          args: { fact_key: 'pickup_location' },
          created_at: '2026-08-28T00:00:00.000Z',
        },
      ],
    })
    const effect = effectFor(bundle)
    expect(effect.authorized).toBe(true)
    expect(effect.consequential).toBe(false)
  })

  it('a high-risk call that only STAGED a pending action (matching request_id, tool, AND args) is authorized:false, non-consequential, and outcome:noop — never a manufactured success', () => {
    const bundle = baseBundle({
      toolCalls: [
        {
          id: 'tc-1',
          workspace_id: 'ws-1',
          request_id: 'req-stage-1',
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'send_payment_link',
          risk: 'high',
          status: 'SUCCESS', // the gate wrapper's own "staged ok" — NOT a real send
          error_code: null,
          error: null,
          args: { body: 'hi customer A', link: 'https://pay.example/a' },
          created_at: '2026-08-28T00:00:00.000Z',
        },
      ],
      pendingActions: [
        {
          id: 'pa-a',
          workspace_id: 'ws-1',
          tool_name: 'send_payment_link',
          argsKeyHash: argsA,
          operatorId: 1,
          created_in_request_id: 'req-stage-1',
          created_at: '2026-08-28T00:00:00.000Z',
          executed_at: null,
          cancelled_at: null,
        },
      ],
    })
    const effect = effectFor(bundle)
    expect(effect.authorized).toBe(false)
    expect(effect.consequential).toBe(false)
    expect(effect.outcome).toBe('noop')
  })

  it('a high-risk call corroborated by a confirmed (executed_at set) pending_actions row for the SAME tool_name + args_key + operator is authorized:true and consequential', () => {
    const bundle = baseBundle({
      toolCalls: [
        {
          id: 'tc-2',
          workspace_id: 'ws-1',
          request_id: 'req-confirm-1', // different request_id from the staging call
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'send_payment_link',
          risk: 'high',
          status: 'SUCCESS',
          error_code: null,
          error: null,
          args: { body: 'hi customer A', link: 'https://pay.example/a' },
          created_at: '2026-08-28T00:05:00.000Z',
        },
      ],
      pendingActions: [
        {
          id: 'pa-a',
          workspace_id: 'ws-1',
          tool_name: 'send_payment_link',
          argsKeyHash: argsA,
          operatorId: 1,
          created_in_request_id: 'req-stage-1',
          created_at: '2026-08-28T00:00:00.000Z',
          executed_at: '2026-08-28T00:05:00.000Z',
          cancelled_at: null,
        },
      ],
    })
    const effect = effectFor(bundle)
    expect(effect.authorized).toBe(true)
    expect(effect.consequential).toBe(true)
  })

  it('a confirm_pending_action call is corroborated via args.pending_action_id, not bare tool_name matching', () => {
    const bundle = baseBundle({
      toolCalls: [
        {
          id: 'tc-3',
          workspace_id: 'ws-1',
          request_id: 'req-confirm-2',
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'confirm_pending_action',
          risk: 'high',
          status: 'SUCCESS',
          error_code: null,
          error: null,
          args: { pending_action_id: 'pa-9' },
          created_at: '2026-08-28T00:05:00.000Z',
        },
      ],
      pendingActions: [
        {
          id: 'pa-9',
          workspace_id: 'ws-1',
          tool_name: 'cancel_booking',
          argsKeyHash: hashArgsObject({ booking_id: 'b-1' }),
          operatorId: 1,
          created_in_request_id: 'req-stage-2',
          created_at: '2026-08-28T00:00:00.000Z',
          executed_at: '2026-08-28T00:05:00.000Z',
          cancelled_at: null,
        },
      ],
    })
    const effect = effectFor(bundle)
    expect(effect.authorized).toBe(true)
  })

  it('a high-risk call with NO corroborating pending_actions record is left unknown (authorized undefined), not manufactured as true — and the hard-invariant gate correctly flags it', () => {
    const bundle = baseBundle({
      toolCalls: [
        {
          id: 'tc-4',
          workspace_id: 'ws-1',
          request_id: 'req-orphan-1',
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'send_payment_link',
          risk: 'high',
          status: 'SUCCESS',
          error_code: null,
          error: null,
          args: { body: 'hi customer A', link: 'https://pay.example/a' },
          created_at: '2026-08-28T00:00:00.000Z',
        },
      ],
      // No pendingActions at all — nothing corroborates this row either way.
    })
    const effect = effectFor(bundle)
    expect(effect.authorized).toBeUndefined()
    expect(effect.consequential).toBe(true)

    const gate = new BenchInvariantGate()
    const violations = gate.evaluate(effect, effect.workspaceId)
    expect(violations.map((v) => v.invariant)).toContain('unauthorized_consequential_action')
  })

  it('two concurrent pending actions for the SAME tool with DIFFERENT args — only one executed — do NOT cross-authorize each other (the exact conflation bug)', () => {
    // Customer A's send_payment_link was staged and NEVER confirmed.
    // Customer B's send_payment_link (different args, same tool, same
    // correlation window) WAS confirmed. Bare tool_name matching would
    // wrongly let B's execution "prove" A's call was authorized too.
    const bundle = baseBundle({
      toolCalls: [
        {
          id: 'tc-a',
          workspace_id: 'ws-1',
          request_id: 'req-a-orphan',
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'send_payment_link',
          risk: 'high',
          status: 'SUCCESS',
          error_code: null,
          error: null,
          args: { body: 'hi customer A', link: 'https://pay.example/a' },
          created_at: '2026-08-28T00:00:00.000Z',
        },
      ],
      pendingActions: [
        // Customer A's own stage — never executed.
        {
          id: 'pa-a',
          workspace_id: 'ws-1',
          tool_name: 'send_payment_link',
          argsKeyHash: argsA,
          operatorId: 1,
          created_in_request_id: 'req-a-stage-earlier', // NOT tc-a's own request_id — simulates tc-a being a resubmission attempt, not the original stage
          created_at: '2026-08-27T23:50:00.000Z',
          executed_at: null,
          cancelled_at: null,
        },
        // Customer B's own, unrelated, genuinely-confirmed action —
        // same tool, same operator, DIFFERENT args, within the same
        // correlation window.
        {
          id: 'pa-b',
          workspace_id: 'ws-1',
          tool_name: 'send_payment_link',
          argsKeyHash: argsB,
          operatorId: 1,
          created_in_request_id: 'req-b-stage',
          created_at: '2026-08-28T00:00:30.000Z',
          executed_at: '2026-08-28T00:01:00.000Z',
          cancelled_at: null,
        },
      ],
    })
    const effect = effectFor(bundle)
    // Not staging (tc-a's own request_id doesn't match pa-a's
    // created_in_request_id), and B's execution must NOT corroborate A's
    // call — no proof either way.
    expect(effect.authorized).toBeUndefined()
    expect(effect.consequential).toBe(true)

    const gate = new BenchInvariantGate()
    const violations = gate.evaluate(effect, effect.workspaceId)
    expect(violations.map((v) => v.invariant)).toContain('unauthorized_consequential_action')
  })

  it('repeated same-tool calls within ONE request (different args) do not get conflated — each staging call matches only its OWN pending action', () => {
    // One inbound-message-handling request stages TWO different
    // send_payment_link calls (two different customers/links) in the
    // same turn. Each caye_tool_calls row must classify as staging
    // against ITS OWN pending_actions row, not the sibling one.
    const bundle = baseBundle({
      selector: { kind: 'consequential-action', workspaceId: 'ws-1', requestId: 'req-shared' },
      toolCalls: [
        {
          id: 'tc-shared-a',
          workspace_id: 'ws-1',
          request_id: 'req-shared',
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'send_payment_link',
          risk: 'high',
          status: 'SUCCESS',
          error_code: null,
          error: null,
          args: { body: 'hi customer A', link: 'https://pay.example/a' },
          created_at: '2026-08-28T00:00:00.000Z',
        },
        {
          id: 'tc-shared-b',
          workspace_id: 'ws-1',
          request_id: 'req-shared',
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'send_payment_link',
          risk: 'high',
          status: 'SUCCESS',
          error_code: null,
          error: null,
          args: { body: 'hi customer B', link: 'https://pay.example/b' },
          created_at: '2026-08-28T00:00:01.000Z',
        },
      ],
      pendingActions: [
        {
          id: 'pa-shared-a',
          workspace_id: 'ws-1',
          tool_name: 'send_payment_link',
          argsKeyHash: argsA,
          operatorId: 1,
          created_in_request_id: 'req-shared',
          created_at: '2026-08-28T00:00:00.000Z',
          executed_at: null,
          cancelled_at: null,
        },
        {
          id: 'pa-shared-b',
          workspace_id: 'ws-1',
          tool_name: 'send_payment_link',
          argsKeyHash: argsB,
          operatorId: 1,
          created_in_request_id: 'req-shared',
          created_at: '2026-08-28T00:00:01.000Z',
          executed_at: null,
          cancelled_at: null,
        },
      ],
    })
    const effects = effectsFor(bundle)
    expect(effects.length).toBe(2)
    // Both are genuinely staging-only calls — each correctly classified
    // as its own stage (via argsHash), neither borrowed the other's
    // pending-action row, both authorized:false, neither consequential.
    for (const effect of effects) {
      expect(effect.authorized).toBe(false)
      expect(effect.consequential).toBe(false)
      expect(effect.outcome).toBe('noop')
    }
  })
})
