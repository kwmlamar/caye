import Link from 'next/link'

export const metadata = {
  title: 'Terms · Caye',
}

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-cream text-near-black font-sans">
      <div className="max-w-2xl mx-auto px-6 py-24 space-y-8">
        <Link
          href="/"
          className="text-[12.5px] font-mono uppercase tracking-wider text-near-black/55 hover:text-near-black transition-colors"
        >
          ← Back
        </Link>

        <div className="space-y-3">
          <h1 className="font-instrument text-4xl md:text-5xl text-near-black tracking-[-0.018em] leading-tight">
            Terms of Service
          </h1>
          <p className="text-[12.5px] font-mono uppercase tracking-wider text-near-black/45">
            Last updated: 2026-07-01
          </p>
        </div>

        <p className="text-near-black/75 leading-relaxed">
          These terms govern your use of Caye, a product of{' '}
          <strong className="text-near-black">TropiTech Solutions</strong>, a Bahamian company.
          By signing up for or using Caye, you agree to them. If you don&apos;t agree, don&apos;t use the service.
        </p>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            What Caye is
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Caye is an AI employee for small businesses. She reads your customer messages across connected channels (WhatsApp, email, Messenger, Instagram), replies in your voice, and helps you handle bookings, quotes, and follow-ups. You (the operator) stay in control — Caye works for you, not the other way around.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Account &amp; eligibility
          </h2>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>You must be at least 18 years old and legally able to enter contracts.</li>
            <li>You must own or be authorized to represent the business you register.</li>
            <li>You&apos;re responsible for keeping your account credentials secure and for anyone acting on your account.</li>
            <li>Provide accurate information at signup and keep it current.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Subscription &amp; refunds
          </h2>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>
              <strong className="text-near-black">Plan:</strong> $79 USD per
              month, billed monthly via Stripe. Your billing cycle anchors to
              the day of your first successful charge.
            </li>
            <li>
              <strong className="text-near-black">30-day money-back
              guarantee (month 1 only):</strong> if Caye isn&apos;t working
              for your business in your first 30 days, email{' '}
              <a
                href="mailto:lamar@tropitech.org?subject=Caye%20refund"
                className="text-caribbean-teal-deep hover:underline"
              >
                lamar@tropitech.org
              </a>{' '}
              and we&apos;ll refund your first month, no questions asked.
            </li>
            <li>
              <strong className="text-near-black">After month 1:</strong>{' '}
              cancellations are pro-rated for the unused portion of the
              current billing cycle. Refunds are not offered beyond month 1
              outside of pro-ration on cancellation.
            </li>
            <li>
              <strong className="text-near-black">Cancellation:</strong>{' '}
              cancel any time by emailing{' '}
              <a
                href="mailto:lamar@tropitech.org?subject=Caye%20cancellation"
                className="text-caribbean-teal-deep hover:underline"
              >
                lamar@tropitech.org
              </a>{' '}
              or through your Stripe billing portal. Access continues to
              end-of-cycle on cancellation.
            </li>
            <li>
              <strong className="text-near-black">Price changes:</strong> we may adjust pricing with at least 30 days&apos; notice by email. Continued use after the notice period constitutes acceptance.
            </li>
            <li>
              <strong className="text-near-black">Failed payments:</strong> after two failed payment attempts, we may suspend Caye until billing is resolved.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Acceptable use
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Don&apos;t use Caye to:
          </p>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-1.5">
            <li>Send spam, unsolicited marketing, or content prohibited by the channel providers (WhatsApp, Meta, Google, Zoho)</li>
            <li>Deceive, harass, defraud, or harm end customers</li>
            <li>Impersonate any person or entity you don&apos;t represent</li>
            <li>Violate any law, including consumer protection, anti-spam, and data protection laws in the jurisdictions where you operate</li>
            <li>Reverse-engineer, decompile, or attempt to extract Caye&apos;s underlying prompts, models, or infrastructure</li>
            <li>Use Caye to build a competing service</li>
          </ul>
          <p className="text-near-black/75 leading-relaxed pt-2">
            We may suspend or terminate your account for violations, immediately in cases of serious abuse.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Your content &amp; ownership
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            You own your data — the business info you configure, the messages Caye handles on your behalf, and the voice-and-tone samples you provide. By using Caye, you grant TropiTech a limited license to process this data solely to operate the service on your behalf, as described in the{' '}
            <Link href="/privacy" className="text-caribbean-teal-deep hover:underline">Privacy Policy</Link>.
          </p>
          <p className="text-near-black/75 leading-relaxed pt-2">
            Caye&apos;s drafted replies are generated for you; you&apos;re responsible for what gets sent under your name. TropiTech, the &ldquo;Caye&rdquo; name, the brand, and the underlying software remain the property of TropiTech Solutions.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Third-party channels
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Caye connects to WhatsApp Business, Meta (Facebook Messenger, Instagram), Zoho, Google (Gmail), and similar third-party services. Your use of those channels through Caye is also subject to their terms of service. If a channel provider suspends your access for any reason, Caye can&apos;t reach that inbox until it&apos;s restored.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Service availability &amp; changes
          </h2>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>We work to keep Caye running but don&apos;t guarantee 100% uptime. Scheduled maintenance and outages happen.</li>
            <li>We may change features, add limits, or discontinue parts of the service. We&apos;ll give reasonable notice for material changes.</li>
            <li>Caye is a young product. Bugs and misfires happen; we fix them as we find them. If Caye ships something wrong on your behalf, we&apos;ll work with you to correct it.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Warranties &amp; liability
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Caye is provided <strong className="text-near-black">&ldquo;as is&rdquo;</strong> without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.
          </p>
          <p className="text-near-black/75 leading-relaxed pt-2">
            To the fullest extent permitted by law, TropiTech Solutions is not liable for indirect, incidental, consequential, or punitive damages. Our total liability to you for any claim arising out of these terms or your use of Caye is limited to the amount you paid us in the 3 months preceding the claim.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Indemnity
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            You agree to indemnify TropiTech Solutions against claims arising from your misuse of Caye, your violation of these terms, or your violation of any third-party rights (including your end customers&apos; rights).
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Termination
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            You can cancel at any time. We can terminate your account for material violations of these terms with reasonable notice, or immediately for serious abuse (spam, fraud, illegal activity). On termination, your access ends and your data is handled per the retention schedule in the{' '}
            <Link href="/privacy" className="text-caribbean-teal-deep hover:underline">Privacy Policy</Link>{' '}
            and the{' '}
            <Link href="/data-deletion" className="text-caribbean-teal-deep hover:underline">Data Deletion Instructions</Link>.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Governing law
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            These terms are governed by the laws of The Commonwealth of The Bahamas. Any dispute that can&apos;t be resolved by direct conversation with{' '}
            <a href="mailto:lamar@tropitech.org?subject=Caye%20dispute" className="text-caribbean-teal-deep hover:underline">lamar@tropitech.org</a>{' '}
            will be resolved in the courts of The Bahamas.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Changes to these terms
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            When we change these terms materially, we&apos;ll notify active operators by email at least 30 days before the change takes effect. The &ldquo;Last updated&rdquo; date above always reflects the current version.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Contact
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            TropiTech Solutions<br />
            Eleuthera, The Bahamas<br />
            <a href="mailto:lamar@tropitech.org?subject=Caye" className="text-caribbean-teal-deep hover:underline">lamar@tropitech.org</a>
          </p>
        </section>
      </div>
    </main>
  )
}
