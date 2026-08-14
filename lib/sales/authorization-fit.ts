export interface BoundedInboxAuthorizationCandidate {
  authorityType: 'one_time'
  capabilityKey: 'customer_inbox_response'
  scopeSubjectKey: 'customer_inquiry_response'
  scopeDescription: string
  scopeMetadata: { max_inquiries: number }
}

// This is a detection seam, not an authority decision. Its caller must first
// establish the sender as a verified workspace owner/founder at the DB seam.
const DIRECT_BOUNDED_GRANT = /\b(?:yes|yeah|please|go ahead)[,.!\s]+(?:you can )?(?:handle|answer|respond to)\s+(?:the |my )?(?:next )?(\d{1,2})\s+(?:customer )?(?:inquiries|enquiries|messages)\b/i

/** Recognizes only an explicit finite permission for the Phase 3 proof job. */
export function deriveBoundedInboxAuthorization(body: string | null | undefined): BoundedInboxAuthorizationCandidate | null {
  const match = body?.match(DIRECT_BOUNDED_GRANT)
  const maxInquiries = Number(match?.[1])
  if (!Number.isInteger(maxInquiries) || maxInquiries < 1 || maxInquiries > 25) return null
  return {
    authorityType: 'one_time', capabilityKey: 'customer_inbox_response', scopeSubjectKey: 'customer_inquiry_response',
    scopeDescription: `Handle the next ${maxInquiries} customer inquiries.`, scopeMetadata: { max_inquiries: maxInquiries },
  }
}
