import Link from 'next/link'

export const metadata = {
  title: 'Privacy · Caye',
}

export default function PrivacyPage() {
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
            Privacy Policy
          </h1>
          <p className="text-[12.5px] font-mono uppercase tracking-wider text-near-black/45">
            Last updated: 2026-07-01
          </p>
        </div>

        <p className="text-near-black/75 leading-relaxed">
          Caye is a product of <strong className="text-near-black">TropiTech Solutions</strong>,
          a Bahamian company. This policy explains what data we collect,
          how we use it, and your rights over it. Plain language, no lawyer traps.
        </p>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Who this policy covers
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Two groups of people show up in Caye:
          </p>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>
              <strong className="text-near-black">Operators</strong> — the
              business owner or staff who sign up for Caye to answer their
              customer inquiries (e.g. a tour operator, restaurant owner).
            </li>
            <li>
              <strong className="text-near-black">End customers</strong> — the
              people messaging the operator&apos;s WhatsApp, email, or social
              accounts. Caye reads and replies on the operator&apos;s behalf.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            What we collect
          </h2>

          <p className="text-near-black/75 leading-relaxed"><strong className="text-near-black">From operators:</strong></p>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-1.5">
            <li>Name, email, phone number, business name, timezone</li>
            <li>Authentication credentials (via Google, Facebook, or email)</li>
            <li>Payment information (handled by Stripe — we never see your card)</li>
            <li>Your voice-and-tone samples so Caye replies in your style</li>
            <li>Your business hours, service catalog, pricing, and blackout dates</li>
          </ul>

          <p className="text-near-black/75 leading-relaxed pt-2"><strong className="text-near-black">From end customers (via connected channels):</strong></p>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-1.5">
            <li>Message content sent to the operator&apos;s WhatsApp, email, Instagram, or Facebook accounts</li>
            <li>Name, phone number, email address if provided in the message</li>
            <li>Booking or reservation details when captured through a conversation</li>
            <li>Metadata: timestamps, thread IDs, delivery status</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            How we use it
          </h2>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>To let Caye read incoming messages and draft or send replies on the operator&apos;s behalf</li>
            <li>To book, reschedule, or cancel appointments and reservations in the operator&apos;s system</li>
            <li>To notify the operator when Caye needs a call (via their own WhatsApp)</li>
            <li>To bill the operator&apos;s subscription</li>
            <li>To detect abuse, spam, or misuse of the platform</li>
            <li>To improve accuracy and reliability of Caye&apos;s replies over time</li>
          </ul>
          <p className="text-near-black/75 leading-relaxed pt-2">
            <strong className="text-near-black">We do not sell your data.</strong>{' '}
            We do not use end-customer messages to train third-party AI models.
            We do not share operator or end-customer contact data with advertisers.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Who we share with
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            We use a small number of infrastructure providers who process data on our behalf under contract:
          </p>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>
              <strong className="text-near-black">Anthropic</strong> — the model provider that generates reply drafts. Message content is sent to Anthropic only for the duration of a single reply generation; Anthropic does not train on our API traffic.
            </li>
            <li>
              <strong className="text-near-black">Supabase</strong> — our database and authentication host (encryption at rest and in transit).
            </li>
            <li>
              <strong className="text-near-black">Vercel</strong> — application hosting.
            </li>
            <li>
              <strong className="text-near-black">Stripe</strong> — subscription billing and payment processing.
            </li>
            <li>
              <strong className="text-near-black">Meta Platforms (WhatsApp Business, Messenger, Instagram)</strong> — messaging channel providers when an operator connects those channels.
            </li>
            <li>
              <strong className="text-near-black">Zoho, Google (Gmail)</strong> — email channel providers when an operator connects those accounts.
            </li>
            <li>
              <strong className="text-near-black">Cron-job.org</strong> — scheduled polling of connected inboxes.
            </li>
          </ul>
          <p className="text-near-black/75 leading-relaxed pt-2">
            We may also disclose data if required by law, court order, or to protect the rights, property, or safety of TropiTech, our users, or the public.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            How long we keep it
          </h2>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>Operator account data: for the life of the subscription and up to 90 days after cancellation.</li>
            <li>Message logs: 12 months rolling, then deleted unless the operator has explicitly asked us to retain longer for audit purposes.</li>
            <li>Billing records: 7 years, as required for tax and financial audit compliance.</li>
            <li>Backups: encrypted, rotated on a 30-day cycle.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Your rights
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            You can:
          </p>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>Request a copy of the data we hold on you</li>
            <li>Correct inaccurate data</li>
            <li>Request deletion (see{' '}
              <Link href="/data-deletion" className="text-caribbean-teal-deep hover:underline">Data Deletion Instructions</Link>)
            </li>
            <li>Withdraw consent for us to process your data at any time (this will end your ability to use Caye)</li>
            <li>File a complaint with the Bahamas Data Protection Commissioner if you believe we&apos;ve mishandled your data</li>
          </ul>
          <p className="text-near-black/75 leading-relaxed pt-2">
            Email{' '}
            <a href="mailto:lamar@tropitech.org?subject=Caye%20privacy%20request" className="text-caribbean-teal-deep hover:underline">lamar@tropitech.org</a>{' '}
            to exercise any of these rights. We&apos;ll respond within 30 days.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Security
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Data is encrypted in transit (TLS 1.2+) and at rest. Access to production systems is limited to TropiTech staff on a need-to-know basis and logged. Payment card data never touches our servers — Stripe handles that end-to-end.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            International transfers
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            TropiTech Solutions operates from the Bahamas. Some of our providers store data in the United States, European Union, and other regions. When we transfer data across borders, we rely on standard contractual clauses and the providers&apos; own compliance frameworks (GDPR, CCPA, and equivalents).
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Children
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Caye is a business tool. We do not knowingly collect data from anyone under 16. If you believe a child&apos;s data has ended up in our system, email us and we&apos;ll delete it immediately.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Changes to this policy
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            When we materially change how we handle data, we&apos;ll email active operators before the change takes effect. The &ldquo;Last updated&rdquo; date above always reflects the current version.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Contact
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            TropiTech Solutions<br />
            Attn: Privacy<br />
            Eleuthera, The Bahamas<br />
            <a href="mailto:lamar@tropitech.org?subject=Caye%20privacy" className="text-caribbean-teal-deep hover:underline">lamar@tropitech.org</a>
          </p>
        </section>
      </div>
    </main>
  )
}
