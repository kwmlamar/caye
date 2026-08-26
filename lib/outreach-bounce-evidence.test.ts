import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { attributeBounce, originalProviderMessageIdFromNotification } from './outreach-bounce-evidence'

const receipt = { id: 'receipt-1', lead_id: 'lead-1', recipient_email: 'prospect@example.test', provider_message_id: 'zoho-1' }

describe('outreach bounce evidence attribution', () => {
  it('attributes a hard DSN to its exact outbound receipt when provider evidence agrees', () => {
    const result = attributeBounce({ recipientEmail: 'prospect@example.test', originalProviderMessageId: 'zoho-1', receiptsByProviderId: [receipt], receiptsByRecipient: [receipt], leadIdByRecipient: 'lead-1' })
    expect(result).toMatchObject({ status: 'outbound_attributed', leadId: 'lead-1', recipientEmail: 'prospect@example.test', receipt })
  })

  it('does not suppress a recipient when structured evidence conflicts', () => {
    const result = attributeBounce({ recipientEmail: 'other@example.test', originalProviderMessageId: 'zoho-1', receiptsByProviderId: [receipt], receiptsByRecipient: [], leadIdByRecipient: 'lead-2' })
    expect(result).toMatchObject({ status: 'ambiguous', recipientEmail: null, leadId: null })
  })

  it('keeps an address-only DSN auditable but does not invent an outbound send', () => {
    const result = attributeBounce({ recipientEmail: 'prospect@example.test', originalProviderMessageId: null, receiptsByProviderId: [], receiptsByRecipient: [], leadIdByRecipient: 'lead-1' })
    expect(result).toMatchObject({ status: 'recipient_attributed', receipt: null, leadId: 'lead-1' })
  })

  it('rejects malformed or free-text-only provider identifiers', () => {
    expect(originalProviderMessageIdFromNotification('the old message id was zoho-1')).toBeNull()
    expect(originalProviderMessageIdFromNotification('Original-Message-ID: <zoho-1>')).toBe('zoho-1')
  })
})
