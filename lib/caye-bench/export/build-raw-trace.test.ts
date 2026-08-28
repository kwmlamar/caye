import { describe, expect, it } from 'vitest'
import { buildRawTrace } from './build-raw-trace'
import { sanitizeRawTrace } from '../replay/sanitize'
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
 * cross-referenced against `caye_pending_actions.executed_at`).
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

function effectFor(bundle: RawExportBundle) {
  const raw = buildRawTrace(bundle, { sourceDescription: 'test' })
  const trace = sanitizeRawTrace(raw, { traceId: 'build-raw-trace-test', salt: 'not-a-secret-test-salt' })
  expect(trace.historicalEffects.length).toBe(1)
  return trace.historicalEffects[0]
}

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

  it('a high-risk call that only STAGED a pending action (its own request_id created the pending_actions row) is authorized:false, non-consequential, and outcome:noop — never a manufactured success', () => {
    const bundle = baseBundle({
      toolCalls: [
        {
          id: 'tc-1',
          workspace_id: 'ws-1',
          request_id: 'req-stage-1',
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'send_reply',
          risk: 'high',
          status: 'SUCCESS', // the gate wrapper's own "staged ok" — NOT a real send
          error_code: null,
          error: null,
          args: { body: 'hi' },
          created_at: '2026-08-28T00:00:00.000Z',
        },
      ],
      pendingActions: [
        {
          id: 'pa-1',
          workspace_id: 'ws-1',
          tool_name: 'send_reply',
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

  it('a high-risk call corroborated by a confirmed (executed_at set) pending_actions row for the same tool is authorized:true and consequential', () => {
    const bundle = baseBundle({
      toolCalls: [
        {
          id: 'tc-2',
          workspace_id: 'ws-1',
          request_id: 'req-confirm-1', // different request_id from the staging call
          operator_allowlist_id: 1,
          caller_role: 'operator',
          tool_name: 'send_reply',
          risk: 'high',
          status: 'SUCCESS',
          error_code: null,
          error: null,
          args: { body: 'hi' },
          created_at: '2026-08-28T00:05:00.000Z',
        },
      ],
      pendingActions: [
        {
          id: 'pa-1',
          workspace_id: 'ws-1',
          tool_name: 'send_reply',
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
          tool_name: 'send_reply',
          risk: 'high',
          status: 'SUCCESS',
          error_code: null,
          error: null,
          args: { body: 'hi' },
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
})
