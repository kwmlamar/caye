import type { Metadata } from 'next'
import CayePresenceDemoClient from './CayePresenceDemoClient'

export const metadata: Metadata = {
  title: 'Caye Presence · dev',
  robots: { index: false, follow: false },
}

export default function CayePresenceDevPage() {
  return <CayePresenceDemoClient />
}
