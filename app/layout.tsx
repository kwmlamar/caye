import type { Metadata } from 'next'
import { Geist, JetBrains_Mono, Playfair_Display, Fraunces, Instrument_Serif, DM_Serif_Display, Newsreader } from 'next/font/google'
import { Toaster } from 'sonner'
import './globals.css'
import './dashboard-ui.css'

const geist = Geist({
  variable: '--font-sans',
  subsets: ['latin'],
})

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
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

export const metadata: Metadata = {
  title: 'Caye',
  description: 'AI-powered workspace for tour operators',
  icons: {
    icon: [
      { url: '/brand/caye-mark.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico' },
    ],
    apple: '/brand/caye-mark-primary-teal.svg',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geist.variable} ${jetbrainsMono.variable} ${playfair.variable} ${fraunces.variable} ${instrumentSerif.variable} ${dmSerif.variable} ${newsreader.variable}`}>
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  )
}

