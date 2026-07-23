import type { Metadata, Viewport } from 'next'
import { Geist, IBM_Plex_Mono, Playfair_Display, Fraunces, Instrument_Serif, DM_Serif_Display, Newsreader, Space_Grotesk } from 'next/font/google'
import { Toaster } from 'sonner'
import GoogleAnalyticsGate from '@/components/analytics/GoogleAnalyticsGate'
import './globals.css'
import './dashboard-ui.css'

const geist = Geist({
  variable: '--font-sans',
  subsets: ['latin'],
})

// Swapped from JetBrains Mono (2026-07-23) — its tall, geometric
// letterforms were reported as straining at the small uppercase-caps
// sizes the founder console runs mono at everywhere (labels, pills,
// timestamps). Plex Mono has the same technical/console character but
// far gentler letterforms at 9-11px.
const ibmPlexMono = IBM_Plex_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})

const playfair = Playfair_Display({
  variable: '--font-serif',
  subsets: ['latin'],
  style: ['italic', 'normal'],
})

const fraunces = Fraunces({
  variable: '--font-logo',
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500', '600', '700'],
})

const instrumentSerif = Instrument_Serif({
  variable: '--font-instrument',
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400'],
})

const dmSerif = DM_Serif_Display({
  variable: '--font-dm',
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400'],
})

const newsreader = Newsreader({
  variable: '--font-newsreader',
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500', '600', '700'],
})

// Founder-console display font — matches the caye-command reference
// mockup's stat-card numerals (2026-07-02 theme pass).
const spaceGrotesk = Space_Grotesk({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['500', '600', '700'],
})

export const metadata: Metadata = {
  metadataBase: new URL('https://www.meetcaye.com'),
  title: {
    default: 'Caye — Your AI Front Desk for WhatsApp',
    template: '%s · Caye',
  },
  description:
    'Caye is a WhatsApp-first AI staff member for tour operators — she answers guests, books tours, and runs your back office over chat. No app to learn.',
  icons: {
    icon: [
      { url: '/brand/caye-orb.svg', type: 'image/svg+xml' },
    ],
    apple: '/brand/caye-orb.svg',
  },
}

// Cream, not white — mobile Safari paints its status-bar and toolbar
// areas with this, so it must match the landing/legal page background
// or the page renders with white bands top and bottom.
export const viewport: Viewport = {
  themeColor: '#FAF7F2',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geist.variable} ${ibmPlexMono.variable} ${playfair.variable} ${fraunces.variable} ${instrumentSerif.variable} ${dmSerif.variable} ${newsreader.variable} ${spaceGrotesk.variable}`}>
        {children}
        <Toaster position="bottom-right" richColors />
        <GoogleAnalyticsGate />
      </body>
    </html>
  )
}

