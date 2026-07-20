'use client'

import { usePathname } from 'next/navigation'
import { GoogleAnalytics } from '@next/third-parties/google'

// Marketing/legal analytics only — never the authenticated back office.
// Dashboard, onboarding, and connect carry operator sessions and
// customer WhatsApp/booking data; keeping GA off those routes means it
// only ever sees anonymous landing-page traffic.
const PRIVATE_PREFIXES = ['/dashboard', '/onboarding', '/connect', '/m', '/auth', '/api']

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID

export default function GoogleAnalyticsGate() {
  const pathname = usePathname()

  if (!GA_MEASUREMENT_ID) return null
  if (PRIVATE_PREFIXES.some((prefix) => pathname?.startsWith(prefix))) return null

  return <GoogleAnalytics gaId={GA_MEASUREMENT_ID} />
}
