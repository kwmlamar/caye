import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { stableArgsKey } from '@/lib/caye-agent/tools/high-risk-gate'
import { findTool } from '@/lib/caye-agent/tools/registry'
import { findHighRiskTool } from '@/lib/caye-agent/tools/high-risk-registry'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('freight shared server operations — transport parity', () => {
  it('makes the dashboard route a thin adapter over the shared generation/send operations', () => {
    const route = source('app/api/founder/freight-workflow/route.ts')
    expect(route).toContain("from '@/lib/freight/server-operations'")
    expect(route).toContain('generateFreightDocument({')
    expect(route).toContain('sendFreightDocument({')
    expect(route).not.toContain("from '@/lib/gmail-send'")
    expect(route).not.toContain("from '@/lib/artifacts/ingest'")
    expect(route).not.toContain("from '@/lib/conversation-execution'")
  })

  it('makes WhatsApp prepare/send tools call the same domain operations, never Gmail directly', () => {
    const prepare = source('lib/caye-agent/tools/write-low/prepare-freight-document.ts')
    const send = source('lib/caye-agent/tools/write-high/send-freight-document.ts')
    expect(prepare).toContain('generateFreightDocument({')
    expect(send).toContain('sendFreightDocument({')
    expect(prepare).not.toContain("@/lib/gmail-send")
    expect(send).not.toContain("@/lib/gmail-send")
  })

  it('keeps the only freight Gmail attachment dispatch inside the shared server operation', () => {
    const shared = source('lib/freight/server-operations.ts')
    expect(shared).toContain("from '@/lib/gmail-send'")
    expect(shared.match(/sendGmailReplyWithAttachments\(/g)).toHaveLength(1)
    expect(shared).toContain('claimConversationExecution({')
    expect(shared).toContain('validateConversationExecution({')
    expect(shared).toContain('resolveConversationExecutionAfterFailure(')
    expect(shared).toContain('completeConversationExecution(')
  })

  it('does not introduce a Bedrock write path', () => {
    const shared = source('lib/freight/server-operations.ts')
    const prepare = source('lib/caye-agent/tools/write-low/prepare-freight-document.ts')
    const send = source('lib/caye-agent/tools/write-high/send-freight-document.ts')
    expect(`${shared}\n${prepare}\n${send}`).not.toMatch(/bedrock|tropitrack/i)
  })
})

describe('freight tool risk and exact approval binding', () => {
  it('registers prepare as autonomous low-risk and send as confirmable high-risk', () => {
    expect(findTool('prepare_freight_document')?.risk).toBe('low')
    expect(findTool('send_freight_document')?.risk).toBe('high')
    expect(findHighRiskTool('send_freight_document')?.name).toBe('send_freight_document')
  })

  it('requires exact artifact/version/recipient/thread fields for send', () => {
    const send = findHighRiskTool('send_freight_document')
    const required = (send?.inputSchema.required ?? []) as string[]
    expect(required).toEqual(expect.arrayContaining([
      'conversation_id', 'artifact_id', 'artifact_version', 'recipient', 'email_thread_id',
    ]))
  })

  it('changes the staged high-risk key when artifact or delivery target changes', () => {
    const base = {
      conversation_id: 'conv-1',
      artifact_id: 'artifact-1',
      artifact_version: 'v1',
      recipient: 'nicole@example.test',
      email_thread_id: 'thread-1',
    }
    expect(stableArgsKey(base)).not.toBe(stableArgsKey({ ...base, artifact_version: 'v2' }))
    expect(stableArgsKey(base)).not.toBe(stableArgsKey({ ...base, recipient: 'other@example.test' }))
    expect(stableArgsKey(base)).not.toBe(stableArgsKey({ ...base, email_thread_id: 'thread-2' }))
  })

  it('keeps generic send-it resolution fail-closed when multiple prepared workflows exist', () => {
    const readTool = source('lib/caye-agent/tools/read/get-freight-workflows.ts')
    expect(readTool).toContain('send_ambiguous: prepared.length > 1')
    expect(readTool).toContain('generic action words are ignored')
  })
})
