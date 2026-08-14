const OUTREACH_EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10}$/

export function isValidOutreachEmail(value: string): boolean {
  return value.length <= 254 && OUTREACH_EMAIL_RE.test(value)
}
