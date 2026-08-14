/**
 * Names from the fixed onboarding contact question are stronger evidence
 * than a WhatsApp profile or the temporary business-name placeholder used
 * while an owner claims a workspace.
 */
export function parseOnboardingNameAndEmail(answer: string): { fullName: string | null; email: string | null } {
  const match = answer.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  const email = match ? match[0] : null
  const withoutEmail = email ? answer.replace(email, ' ') : answer
  const fullName = withoutEmail
    .replace(/\b(my name is|i'?m|this is|name|email)\b[:\s]*/gi, ' ')
    .replace(/[,:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { fullName: fullName || null, email }
}

/** Whether an onboarding name should repair the displayed operator name. */
export function shouldSyncOnboardingOperatorName(
  currentName: string | null | undefined,
  onboardingName: string | null | undefined,
  businessName: string | null | undefined
): boolean {
  const candidate = onboardingName?.trim()
  if (!candidate) return false

  const current = currentName?.trim()
  if (!current) return true
  if (current.toLowerCase() === 'operator') return true

  const business = businessName?.trim()
  return !!business && current.toLowerCase() === business.toLowerCase()
}
