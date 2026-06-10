import Link from 'next/link'

export const metadata = {
  title: 'Privacy · Caye',
}

export default function PrivacyPage() {
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
          Privacy
        </h1>
        <p className="text-near-black/70 leading-relaxed">
          Caye reads your inbox and message channels to reply on your behalf.
          We don&apos;t sell your data. We don&apos;t share customer messages
          with third parties beyond the model providers we use to draft
          replies (currently Anthropic). Full policy is being drafted.
          Questions:{' '}
          <a
            href="mailto:lamar@tropitech.org?subject=Caye%20privacy"
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
