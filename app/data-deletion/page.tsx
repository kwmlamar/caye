import Link from 'next/link'

export const metadata = {
  title: 'Data Deletion · Caye',
}

export default function DataDeletionPage() {
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
            Data Deletion Instructions
          </h1>
          <p className="text-[12.5px] font-mono uppercase tracking-wider text-near-black/45">
            Last updated: 2026-07-01
          </p>
        </div>

        <p className="text-near-black/75 leading-relaxed">
          You have the right to ask us to delete personal data we hold about you.
          Caye is a product of <strong className="text-near-black">TropiTech Solutions</strong>{' '}
          (Bahamas). This page explains how to request deletion, what gets deleted, and how long it takes.
        </p>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Who this is for
          </h2>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>
              <strong className="text-near-black">Operators</strong> — the business owner or staff who signed up for Caye.
            </li>
            <li>
              <strong className="text-near-black">End customers</strong> — people whose messages passed through an operator&apos;s Caye-connected inbox (WhatsApp, email, Messenger, Instagram).
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            How to request deletion
          </h2>

          <p className="text-near-black/75 leading-relaxed">
            <strong className="text-near-black">Email:</strong>{' '}
            <a
              href="mailto:lamar@tropitech.org?subject=Caye%20data%20deletion%20request"
              className="text-caribbean-teal-deep hover:underline"
            >
              lamar@tropitech.org
            </a>{' '}
            with the subject line{' '}
            <span className="font-mono text-[13px] px-1.5 py-0.5 rounded bg-near-black/[0.05]">Caye data deletion request</span>.
          </p>

          <p className="text-near-black/75 leading-relaxed pt-2">
            Include in your message:
          </p>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-1.5">
            <li>Which category applies (operator or end customer)</li>
            <li>
              The identifying details we would have on file — for operators, your account email and business name; for end customers, the phone number, email address, or social handle you used to reach the business
            </li>
            <li>The name of the business whose Caye received your messages (end customers only) — this helps us find your data faster</li>
            <li>Confirmation that you&apos;re the owner of the data being requested</li>
          </ul>

          <p className="text-near-black/75 leading-relaxed pt-2">
            We may ask a follow-up question to verify identity before we act — this protects you from someone else deleting your data without permission.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            What gets deleted
          </h2>

          <p className="text-near-black/75 leading-relaxed"><strong className="text-near-black">For operators:</strong></p>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-1.5">
            <li>Your account, authentication credentials, and business configuration</li>
            <li>Your voice-and-tone samples, service catalog, and workspace settings</li>
            <li>All customer conversations, bookings, and contacts stored in your workspace</li>
            <li>Connected-channel tokens (WhatsApp, email, Meta, Google, Zoho) — we revoke and delete these</li>
          </ul>

          <p className="text-near-black/75 leading-relaxed pt-2"><strong className="text-near-black">For end customers:</strong></p>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-1.5">
            <li>Message threads containing your contact identifier (phone, email, social handle)</li>
            <li>Contact records created for you across affected operator workspaces</li>
            <li>Any booking or reservation records that reference you</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            What we may retain (and why)
          </h2>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>
              <strong className="text-near-black">Billing and tax records</strong> — retained for 7 years to comply with Bahamian and applicable foreign tax law. These contain the fact of a transaction but not message content.
            </li>
            <li>
              <strong className="text-near-black">Legal hold</strong> — if we&apos;re under a lawful order or active dispute concerning the data, we may retain it until the matter is resolved.
            </li>
            <li>
              <strong className="text-near-black">Anonymized aggregate metrics</strong> — counts and timing data with no personal identifiers may be retained for service-quality analysis.
            </li>
            <li>
              <strong className="text-near-black">Encrypted backups</strong> — deletion propagates to backups on the next 30-day rotation cycle. Backups are not accessed for any purpose other than disaster recovery.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            How long it takes
          </h2>
          <ul className="text-near-black/75 leading-relaxed list-disc pl-5 space-y-2">
            <li>We acknowledge deletion requests within <strong className="text-near-black">3 business days</strong>.</li>
            <li>Live-system deletion completes within <strong className="text-near-black">30 days</strong> of the verified request.</li>
            <li>Backup rotation completes deletion from encrypted backups within a further <strong className="text-near-black">30 days</strong>.</li>
            <li>We&apos;ll email you a confirmation once each stage is done.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Third-party channels
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Caye reads and replies through third-party services (WhatsApp Business, Meta, Google, Zoho, Stripe). Deleting data from Caye does not delete it from those providers — you&apos;ll need to request deletion directly with each provider you want your data removed from. We can point you to the relevant help pages if you email us.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            After deletion
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Once your data is deleted, Caye can no longer function for you — operators lose access to their workspace; end customers whose contacts have been removed won&apos;t appear in any future replies. Deletion is not reversible.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Questions or complaints
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            Email{' '}
            <a
              href="mailto:lamar@tropitech.org?subject=Caye%20data%20deletion%20question"
              className="text-caribbean-teal-deep hover:underline"
            >
              lamar@tropitech.org
            </a>
            . If you believe we&apos;ve mishandled a deletion request, you can also file a complaint with the Bahamas Data Protection Commissioner.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-instrument text-2xl text-near-black tracking-[-0.012em]">
            Contact
          </h2>
          <p className="text-near-black/75 leading-relaxed">
            TropiTech Solutions<br />
            Attn: Data Deletion<br />
            Eleuthera, The Bahamas<br />
            <a href="mailto:lamar@tropitech.org?subject=Caye%20data%20deletion" className="text-caribbean-teal-deep hover:underline">lamar@tropitech.org</a>
          </p>
        </section>
      </div>
    </main>
  )
}
