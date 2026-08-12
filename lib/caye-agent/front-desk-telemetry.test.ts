import { describe, it, expect, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { deriveOutcome } from './front-desk-telemetry'

vi.mock('server-only', () => ({}))

const block = (
  partial: Partial<Anthropic.ToolResultBlockParam>
): Anthropic.ToolResultBlockParam =>
  ({ type: 'tool_result', tool_use_id: 't1', ...partial }) as Anthropic.ToolResultBlockParam

describe('deriveOutcome — the shapes caye-reply actually pushes', () => {
  it('reads send_reply’s bare "ok" string as success', () => {
    expect(deriveOutcome(block({ content: 'ok' })).status).toBe('SUCCESS')
  })

  it('reads lookup_price’s { ok: true } as success', () => {
    const b = block({ content: JSON.stringify({ ok: true, data: { price: 150 } }) })
    expect(deriveOutcome(b).status).toBe('SUCCESS')
  })

  it('reads create_booking’s { success: false } as a failure', () => {
    const b = block({
      content: JSON.stringify({ success: false, error: 'service_id not found' }),
      is_error: true,
    })
    const out = deriveOutcome(b)
    expect(out.status).toBe('NOT_FOUND')
    expect(out.error).toBe('service_id not found')
  })

  it('reads check_availability’s plain JSON as success', () => {
    const b = block({ content: JSON.stringify({ date: '2026-08-20', slots: [] }) })
    expect(deriveOutcome(b).status).toBe('SUCCESS')
  })

  it('flags an unknown tool as NOT_FOUND', () => {
    expect(deriveOutcome(block({ content: 'Unknown tool: frobnicate', is_error: true })).status).toBe(
      'NOT_FOUND'
    )
  })

  it('records a branch that pushed nothing', () => {
    expect(deriveOutcome(undefined).status).toBe('FAILED_PERMANENT')
  })
})

describe('deriveOutcome — classification that has to be right', () => {
  it('calls a duplicate booking a CONFLICT, not a generic failure', () => {
    // c96b734 added duplicate detection to this exact path. Counting those
    // apart from real errors is most of the point of logging.
    const b = block({
      content: JSON.stringify({ success: false, error: 'Valencia Wills already has a booking that same day' }),
      is_error: true,
    })
    expect(deriveOutcome(b).status).toBe('CONFLICT')
  })

  it('calls an upstream timeout retryable', () => {
    const b = block({
      content: JSON.stringify({ ok: false, error: 'request timed out, try again' }),
      is_error: true,
    })
    expect(deriveOutcome(b).status).toBe('FAILED_RETRYABLE')
  })

  it('defaults an unrecognised failure to permanent', () => {
    // Opposite default from classifyError, deliberately: nothing retries off
    // this value, it only gets counted, and over-reporting "retryable" would
    // misdescribe what happened.
    const b = block({ content: JSON.stringify({ ok: false, error: 'something odd' }), is_error: true })
    expect(deriveOutcome(b).status).toBe('FAILED_PERMANENT')
  })
})

describe('deriveOutcome — does not cry wolf', () => {
  it('does not invent a failure from unparseable content', () => {
    // Over-reporting failures in week one trains whoever reads the table to
    // ignore it — the dynamic the migration-drift watchdog exists to avoid.
    expect(deriveOutcome(block({ content: 'some prose result' })).status).toBe('SUCCESS')
  })

  it('does not treat the word "error" in a payload as a failure', () => {
    const b = block({ content: JSON.stringify({ ok: true, data: { notes: 'no error reported' } }) })
    expect(deriveOutcome(b).status).toBe('SUCCESS')
  })

  it('trusts is_error even when the payload does not parse', () => {
    const out = deriveOutcome(block({ content: 'exploded', is_error: true }))
    expect(out.status).not.toBe('SUCCESS')
    expect(out.error).toBe('exploded')
  })
})
