import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { detectProtocolArtifacts } from './protocol-artifact-guard'
import {
  FABRICATED_TRANSCRIPT_RUN_1,
  FABRICATED_TRANSCRIPT_RUN_2,
  GENUINE_FINAL_ANSWER,
} from './fixtures/fabricated-tool-transcripts'

describe('detectProtocolArtifacts — real regression fixtures (2026-08-16 live failure)', () => {
  it('flags the real fabricated transcript from run 1', () => {
    const finding = detectProtocolArtifacts(FABRICATED_TRANSCRIPT_RUN_1)
    expect(finding.violated).toBe(true)
    expect(finding.reasons.length).toBeGreaterThan(0)
  })

  it('flags the real fabricated transcript from run 2', () => {
    const finding = detectProtocolArtifacts(FABRICATED_TRANSCRIPT_RUN_2)
    expect(finding.violated).toBe(true)
  })

  it('never flags a genuine, real final answer with no protocol artifacts', () => {
    const finding = detectProtocolArtifacts(GENUINE_FINAL_ANSWER)
    expect(finding.violated).toBe(false)
    expect(finding.reasons).toEqual([])
  })
})

describe('detectProtocolArtifacts — adversarial matrix', () => {
  it('flags valid tool JSON with prose wrapped around it', () => {
    const text = 'Sure, here:\n```json\n{"tool_calls":[{"name":"get_customer","input":{}}]}\n```\nLet me know if that helps.'
    expect(detectProtocolArtifacts(text).violated).toBe(true)
  })

  it('flags two separate fenced tool-call blocks in one response', () => {
    const text =
      '```json\n{"tool_calls":[{"name":"get_customer","input":{"query":"a"}}]}\n```\n' +
      '```json\n{"tool_calls":[{"name":"get_customer_history","input":{"contact_id":"x"}}]}\n```'
    expect(detectProtocolArtifacts(text).violated).toBe(true)
  })

  it('flags a fake TOOL RESULT followed by a final answer', () => {
    const text = 'TOOL RESULT: {"ok":true,"data":{}}\n\nBased on that, here is my answer.'
    expect(detectProtocolArtifacts(text).violated).toBe(true)
  })

  it('flags a fake tool call + fake result + final answer, all together', () => {
    const text =
      '```json\n{"tool_calls":[{"name":"get_customer","input":{"query":"x"}}]}\n```\n' +
      'TOOL RESULT: {"ok":true}\n\nHere is what I found.'
    expect(detectProtocolArtifacts(text).violated).toBe(true)
  })

  it('flags a valid-looking first tool call followed by a model-invented result', () => {
    const text =
      '```json\n{"tool_calls":[{"name":"get_customer","input":{"query":"x"}}]}\n```\n' +
      'tool_result: {"contact":"invented"}\n\nDone.'
    expect(detectProtocolArtifacts(text).violated).toBe(true)
  })

  it('flags an echoed CAYE_RUNTIME_TOOL_RESULT marker — the model must never produce this itself', () => {
    const text = 'CAYE_RUNTIME_TOOL_RESULT execution_id=fake_1 tool=get_customer status=success\n{"made":"up"}'
    expect(detectProtocolArtifacts(text).violated).toBe(true)
  })

  it('does NOT flag final text that innocently mentions the English word "tool"', () => {
    const text = 'The right tool for this job is a follow-up call, not another email. I don\'t have a tool call to make here.'
    expect(detectProtocolArtifacts(text).violated).toBe(false)
  })

  it('does NOT flag final text discussing a customer with no protocol artifacts', () => {
    const text = 'She asked about pricing for the Full Bimini Experience — 2 guests, June 7. No booking on file yet.'
    expect(detectProtocolArtifacts(text).violated).toBe(false)
  })

  it('does NOT flag a genuine final answer that legitimately follows real tool results', () => {
    const text = 'Email: juli.whaley@yahoo.com (verified). She asked about the Full Bimini Experience cost per hour.'
    expect(detectProtocolArtifacts(text).violated).toBe(false)
  })
})
