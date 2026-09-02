import { describe, expect, it } from 'vitest'
import { sanitizeHumanFacingEmail } from './human-facing-email'

describe('sanitizeHumanFacingEmail', () => {
  it('sanitizes subject and body without changing the recipient address', () => {
    const result = sanitizeHumanFacingEmail({
      to: 'ops-test+range–marker@example.com',
      subject: 'Update — Friday',
      body: 'Hours are 9–11 AM. Status ― ready.',
    })

    expect(result.to).toBe('ops-test+range–marker@example.com')
    expect(result.subject).toBe('Update. Friday')
    expect(result.body).not.toMatch(/[—–―]/)
  })
})
