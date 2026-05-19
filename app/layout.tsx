import type { Metadata } from 'next'
import { Geist, JetBrains_Mono } from 'next/font/google'
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

export const metadata: Metadata = {
  title: 'Caye',
  description: 'AI-powered workspace for tour operators',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geist.variable} ${jetbrainsMono.variable}`}>
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  )
}
