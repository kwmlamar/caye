/**
 * Pure functions that inspect a draft reply for persona/identity leaks
 * before we send it. Extracted from caye-reply.ts so they can be unit
 * tested without pulling in the server-only Anthropic + Supabase deps.
 *
 * Used as a safety net behind the system-prompt instructions — even if
 * the model ignores "never sign as Caye" or "never claim to be an AI",
 * we catch it here and hold for the owner instead of letting the
 * email/message ship.
 */

/**
 * Returns a short reason string when the draft contains an identity
 * leak (signed as Caye, claims to be an AI, discloses automation),
 * otherwise null.
 */
export function detectIdentityLeak(content: string): string | null {
  const trimmed = content.trim()
  // Signature region = last ~250 chars, where sign-offs live
  const tail = trimmed.slice(-250).toLowerCase()
  const full = trimmed.toLowerCase()

  // Signed as Caye (any variant)
  const cayeSignoff = /(^|[\s,—\-–·|])caye\s*$|(regards|sincerely|best|thanks|cheers|warmly|warm regards|talk soon)[\s,]+caye\b/i
  if (cayeSignoff.test(tail)) return 'signed as Caye instead of the owner'

  // Self-identifies as AI / assistant / bot / receptionist
  const aiSelfReference = /\b(i am|i'm|this is)\s+(an?\s+)?(ai|a\s+bot|an\s+assistant|an?\s+automated|caye)\b/i
  if (aiSelfReference.test(full)) return 'self-identifies as AI/assistant'

  // Explicit AI / automation language about itself
  const aiDisclosure = /\b(ai\s+receptionist|ai\s+assistant|automated\s+(reply|response|system)|on behalf of\s+\w+\s+via\s+caye)\b/i
  if (aiDisclosure.test(full)) return 'discloses AI nature'

  return null
}
