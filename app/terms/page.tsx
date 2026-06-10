import Link from 'next/link'

export const metadata = {
  title: 'Terms · Caye',
}

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-cream text-near-black font-sans">
      <div className="max-w-2xl mx-auto px-6 py-24 space-y-6">
        <Link
          href="/"
          className="text-[12.5px] font-mono uppercase tracking-wider text-near-black/55 hover:text-near-black transition-colors"
        >
          ← Back
        </Link>
        <h1 className="font-instrument text-4xl md:text-5xl text-near-black tracking-[-0.018em] leading-tight">
          Terms of Service
        </h1>
        <p className="text-near-black/70 leading-relaxed">
          Caye is in private pilot. Full terms are being drafted. In the
          meantime, your use of Caye is governed by the agreement you sign
          when you onboard. Questions: {' '}
          <a
            href="mailto:lamar@tropitech.org?subject=Caye%20terms"
            className="text-caribbean-teal-deep hover:underline"
          >
            lamar@tropitech.org
          </a>
          .
        </p>
      </div>
    </main>
  )
}
