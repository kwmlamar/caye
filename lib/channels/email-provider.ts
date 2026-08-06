import 'server-only'
import { resolveMx } from 'node:dns/promises'

export type EmailProvider = 'google' | 'zoho' | 'microsoft' | 'other'

/**
 * Works out who runs an owner's email from their address alone.
 *
 * Caye already captures the owner's email during discovery, so asking
 * "what tools do you use?" is asking for something she can already see.
 * Detecting it means the connect step opens with "looks like your email
 * runs through Google — want me watching that inbox?" rather than an
 * intake question, which is the difference between a form and someone
 * who did their homework. It also removes a round trip from a flow where
 * every extra message is a place to drop out.
 */

const FREE_DOMAINS: Record<string, EmailProvider> = {
  'gmail.com': 'google',
  'googlemail.com': 'google',
  'zoho.com': 'zoho',
  'zohomail.com': 'zoho',
  'outlook.com': 'microsoft',
  'hotmail.com': 'microsoft',
  'live.com': 'microsoft',
  'msn.com': 'microsoft',
}

/** Matched against MX hostnames, most specific first. */
const MX_SIGNATURES: [RegExp, EmailProvider][] = [
  [/aspmx\.l\.google\.com$|googlemail\.com$|google\.com$/i, 'google'],
  [/zoho\.(com|eu|in)$|zohomail\.(com|eu)$/i, 'zoho'],
  [/outlook\.com$|protection\.outlook\.com$|microsoft\.com$/i, 'microsoft'],
]

export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email.slice(at + 1).trim().toLowerCase() || null
}

/**
 * Returns null when it genuinely can't tell — callers must ask rather
 * than guess. Being confidently wrong about someone's email host is worse
 * than one extra question, because the wrong OAuth link is a dead end
 * they have to back out of.
 */
export async function detectEmailProvider(email: string | null | undefined): Promise<EmailProvider | null> {
  if (!email) return null
  const domain = domainOf(email)
  if (!domain) return null

  const known = FREE_DOMAINS[domain]
  if (known) return known

  try {
    const records = await resolveMx(domain)
    if (!records.length) return null
    // Lowest priority value wins — that's the primary exchanger.
    const primary = [...records].sort((a, b) => a.priority - b.priority)
    for (const record of primary) {
      for (const [pattern, provider] of MX_SIGNATURES) {
        if (pattern.test(record.exchange)) return provider
      }
    }
    return 'other'
  } catch {
    // NXDOMAIN, no MX, DNS timeout — all mean "ask them".
    return null
  }
}
