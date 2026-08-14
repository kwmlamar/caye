import { describe, expect, it } from 'vitest'
import { isValidOutreachEmail } from './outreach-email'

describe('isValidOutreachEmail', () => {
  it('accepts an ordinary business address', () => expect(isValidOutreachEmail('bookings@example.com')).toBe(true))
  it('rejects scraped text appended after the domain', () => expect(isValidOutreachEmail('bookings@bahamaswatertoys.comTelephone')).toBe(false))
})
