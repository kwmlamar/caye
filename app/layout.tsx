import type { Metadata, Viewport } from 'next'
import { Geist, IBM_Plex_Mono, Playfair_Display, Fraunces, Instrument_Serif, DM_Serif_Display, Newsreader, Space_Grotesk, Bricolage_Grotesque, Bodoni_Moda } from 'next/font/google'
import { Toaster } from 'sonner'
import GoogleAnalyticsGate from '@/components/analytics/GoogleAnalyticsGate'
import './globals.css'
import './dashboard-ui.css'
import './caye-direct-composer.css'

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
  weight: ['400', '500', '600', '700', '900'],
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

// Landing hero headline, trial #2 (2026-07-29) — a quirky variable
// grotesque with real display personality, tried alongside Fraunces
// (trial #1) to see which "stands out" treatment the hero wants.
// Register-different from Fraunces on purpose: this is a sans, not
// another romantic/bold serif, so the two trials read as genuinely
// different directions rather than variations on one idea.
// Kept loaded (unused on the hero now) in case the sans direction
// gets revisited later — see trial #3 below for why it lost out.
const bricolage = Bricolage_Grotesque({
  variable: '--font-bricolage',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
})

// Landing hero headline, trial #3 (2026-07-29) — a bolder serif than
// Fraunces, staying in the register the rest of the hero already
// speaks (Newsreader subhead, mono eyebrow, serif wordmark). Trial #2
// (Bricolage, a sans) broke that register and produced a real mixed-
// voice mismatch, not just a "needs a bolder font" problem — so this
// stays serif on purpose. High-contrast, dramatic strokes for real
// display weight instead of Fraunces' warmer, softer character.
const bodoniModa = Bodoni_Moda({
  variable: '--font-bodoni',
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500', '600', '700', '800', '900'],
})

export const metadata: Metadata = {
  metadataBase: new URL('https://www.meetcaye.com'),
  title: {
    default: 'Caye — Your AI Front Desk for WhatsApp',
    template: '%s · Caye',
  },
  description:
    'Caye is the hire who runs your front desk from your own WhatsApp — she answers guests, books tours, and runs your back office over chat. No app to learn.',
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/icon-192.png',
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
      <body className={`${geist.variable} ${ibmPlexMono.variable} ${playfair.variable} ${fraunces.variable} ${instrumentSerif.variable} ${dmSerif.variable} ${newsreader.variable} ${spaceGrotesk.variable} ${bricolage.variable} ${bodoniModa.variable}`}>
        {children}
        <Toaster position="bottom-right" richColors />
        <GoogleAnalyticsGate />
      </body>
    </html>
  )
}

