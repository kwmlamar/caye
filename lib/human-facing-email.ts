import { sanitizeHumanFacingText } from './human-facing-voice'

export interface HumanFacingEmail {
  to: string
  subject: string
  body: string
}

/**
 * Sanitize only text a recipient will read. Routing identity is deliberately
 * untouched so presentation policy can never mutate an address or account id.
 */
export function sanitizeHumanFacingEmail(email: HumanFacingEmail): HumanFacingEmail {
  return {
    to: email.to,
    subject: sanitizeHumanFacingText(email.subject),
    body: sanitizeHumanFacingText(email.body),
  }
}
