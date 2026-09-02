import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn().mockResolvedValue({ error: null }) }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({ rpc }) }))

import { resolveConversationExecutionAfterFailure } from '@/lib/conversation-execution'
import { DispatchAmbiguousError } from '@/lib/whatsapp/channel-dispatch'
import { classifyFreightSendFailure } from './send-safety'

describe('freight Gmail execution safety', () => {
  beforeEach(() => rpc.mockClear())

  it('provider accepted + local persistence failure completes the reservation, so retry cannot resend', async () => {
    await resolveConversationExecutionAfterFailure('claim', classifyFreightSendFailure(true, new Error('insert failed')))
    expect(rpc).toHaveBeenCalledWith('complete_conversation_execution', expect.objectContaining({ p_claim_id: 'claim' }))
  })

  it('an ambiguous provider outcome becomes permanently non-auto-retryable', async () => {
    await resolveConversationExecutionAfterFailure('claim', classifyFreightSendFailure(false, new DispatchAmbiguousError('timeout', false)))
    expect(rpc).toHaveBeenCalledWith('mark_conversation_execution_ambiguous', { p_claim_id: 'claim' })
  })

  it('a definite pre-provider failure remains retryable', async () => {
    await resolveConversationExecutionAfterFailure('claim', classifyFreightSendFailure(false, new Error('artifact unavailable')))
    expect(rpc).toHaveBeenCalledWith('abandon_conversation_execution_response', { p_claim_id: 'claim' })
  })

  it('normal success requires exactly one provider send and no failure resolution', async () => {
    const providerSend = vi.fn().mockResolvedValue({ gmailMessageId: 'gm-1' })
    const persist = vi.fn().mockResolvedValue(undefined)
    const sent = await providerSend(); await persist(sent)
    expect(providerSend).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalled()
  })
})
