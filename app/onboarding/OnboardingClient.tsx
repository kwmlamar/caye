"use client"

import { CayeMark } from "@/components/brand/CayeMark"

interface Props {
  workspaceIdHint?: string
  signupCode?: string
}

// The discovery interview (8 questions → business profile) now runs as a
// real WhatsApp conversation with Caye — see lib/onboarding-whatsapp.ts
// and app/api/webhooks/whatsapp-operator/route.ts. This screen is just
// the handoff: get the owner from "just signed up" to "texting Caye,"
// nothing more. Per CLAUDE.md — if it can happen in chat, it happens in
// chat, not in a web form.
//
// signupCode is invisible zero-width characters appended to the
// prefilled message (see lib/onboarding-whatsapp.ts encodeSignupCode) —
// carries the workspace id to the webhook without the owner ever seeing
// a tracking code, and without an extra "type your number" step.
export default function OnboardingClient({ workspaceIdHint, signupCode }: Props) {
  const cayeNumber = process.env.NEXT_PUBLIC_CAYE_WHATSAPP_NUMBER

  const prefill = `Hi Caye! I just signed up and I'm ready to get set up.${signupCode ?? ""}`
  const waHref = cayeNumber
    ? `https://wa.me/${cayeNumber}?text=${encodeURIComponent(prefill)}`
    : undefined

  return (
    <div className="login-root login-dark">
      <div className="login-card" style={{ textAlign: "center" }}>
        <div className="login-brand" style={{ justifyContent: "center" }}>
          <CayeMark size={36} />
        </div>

        <span className="login-eyebrow">You&apos;re signed up</span>
        <h1 className="login-heading">Now let&apos;s talk to Caye</h1>
        <p className="login-sub">
          She&apos;ll ask a few quick questions about your business over WhatsApp — about 3 minutes — then she&apos;s live.
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

        <p style={{ textAlign: "center", fontSize: 13, color: "rgba(245,245,244,0.45)", marginTop: 20 }}>
          Prefer to skip ahead?{" "}
          <a
            href={workspaceIdHint ? `/connect?ws=${workspaceIdHint}` : "/connect"}
            style={{ color: "var(--tc-sun)", fontWeight: 600, textDecoration: "none" }}
          >
            Connect your channels
          </a>
        </p>
      </div>
    </div>
  )
}
