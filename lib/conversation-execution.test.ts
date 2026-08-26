import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const rpcCalls: Array<{ fn: string; params: unknown }> = []

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    rpc: (fn: string, params: unknown) => {
      rpcCalls.push({ fn, params })
      if ((params as { p_claim_id?: string }).p_claim_id === 'claim-rpc-fails') {
        return Promise.resolve({ data: null, error: { message: 'boom' } })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))

import { resolveConversationExecutionAfterFailure } from './conversation-execution'
import { DispatchAmbiguousError } from './whatsapp/channel-dispatch'

describe('resolveConversationExecutionAfterFailure', () => {
  it('routes a definitely-sent ambiguous error to complete — never treats a confirmed send as retryable', async () => {
    rpcCalls.length = 0
    await resolveConversationExecutionAfterFailure('claim-1', new DispatchAmbiguousError('message sent but not recorded', true))
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('complete_conversation_execution')
    expect(rpcCalls[0].params).toMatchObject({ p_claim_id: 'claim-1' })
  })

  it('routes an outcome-unknown ambiguous error to mark-ambiguous — fails closed, never abandons', async () => {
    rpcCalls.length = 0
    await resolveConversationExecutionAfterFailure('claim-2', new DispatchAmbiguousError('provider send failed or its outcome is unknown', false))
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('mark_conversation_execution_ambiguous')
    expect(rpcCalls[0].params).toMatchObject({ p_claim_id: 'claim-2' })
  })

  it('routes a plain pre-send Error to abandon — safe to retry', async () => {
    rpcCalls.length = 0
    await resolveConversationExecutionAfterFailure('claim-3', new Error('conversation not found'))
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('abandon_conversation_execution_response')
    expect(rpcCalls[0].params).toMatchObject({ p_claim_id: 'claim-3' })
  })

  it('never throws, even if the underlying RPC call itself fails', async () => {
    rpcCalls.length = 0
    await expect(
      resolveConversationExecutionAfterFailure('claim-rpc-fails', new Error('anything'))
    ).resolves.toBeUndefined()
  })
})
