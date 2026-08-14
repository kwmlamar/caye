import { describe, expect, it } from 'vitest'
import { deriveBoundedInboxAuthorization } from './authorization-fit'

describe('bounded Sales authorization detector', () => {
  it('recognizes only an explicit finite inbox directive', () => {
    expect(deriveBoundedInboxAuthorization('Yes, handle the next 5 customer inquiries.')).toEqual({
      authorityType: 'one_time', capabilityKey: 'customer_inbox_response', scopeSubjectKey: 'customer_inquiry_response',
      scopeDescription: 'Handle the next 5 customer inquiries.', scopeMetadata: { max_inquiries: 5 },
    })
  })

  it.each(['Sounds interesting.', 'Maybe you can help.', 'Tell me more.', 'What can you do?', 'Yes, handle customer messages.'])
  ('does not treat vague language as authorization: %s', (body) => {
    expect(deriveBoundedInboxAuthorization(body)).toBeNull()
  })
})
