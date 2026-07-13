"use client"

import Link from "next/link"
import { CayeMark } from "@/components/brand/CayeMark"

export default function SignupPage() {
  const cayeNumber = process.env.NEXT_PUBLIC_CAYE_WHATSAPP_NUMBER
  const prefill = "Hi Caye! I'd like to sign up."
  const waHref = cayeNumber
    ? `https://wa.me/${cayeNumber}?text=${encodeURIComponent(prefill)}`
    : undefined

  return (
    <div className="login-root login-dark">
      <div className="login-card" style={{ textAlign: "center" }}>
        <div className="login-brand" style={{ justifyContent: "center" }}>
          <CayeMark size={36} />
        </div>

        <span className="login-eyebrow">Get started</span>
        <h1 className="login-heading">Sign up by texting Caye</h1>
        <p className="login-sub">
          No form, no account to create. Message her on WhatsApp and she&apos;ll ask a few quick
          questions about your business — about 3 minutes — then she&apos;s live. 14-day free
          trial · No credit card required.
        </p>

        {waHref ? (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary"
            style={{ width: "100%", justifyContent: "center", textDecoration: "none" }}
          >
            Message Caye on WhatsApp
          </a>
        ) : (
          <div className="login-error">
            Caye&apos;s WhatsApp number isn&apos;t configured yet (NEXT_PUBLIC_CAYE_WHATSAPP_NUMBER).
          </div>
        )}

        <p className="login-switch">
          Already have an account?{' '}
          <Link href="/login">Sign in</Link>
        </p>
      </div>

      <p className="login-legal">
        By signing up, you agree to Caye&apos;s{' '}
        <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  )
}
