"use client"

import { useRouter } from "next/navigation"
import ChannelsPanel from "@/components/settings/ChannelsPanel"
import { CayeMark } from "@/components/brand/CayeMark"

interface Props {
  workspaceId: string | null
}

// Reached from Caye's WhatsApp wrap-up message once the discovery grill
// completes (lib/onboarding-whatsapp.ts). Standalone because Meta OAuth
// (Zoho/Gmail/Embedded Signup) needs a browser — the one place a web
// surface is unavoidable even in a WhatsApp-first product. Shares the
// login/signup pages' flat dark theme rather than the settings-panel
// chrome, since this is opened cold from a phone most of the time.
export default function ConnectClient({ workspaceId }: Props) {
  const router = useRouter()

  return (
    <div className="login-root login-dark cx-root">
      <div className="cx-shell">
        <div className="cx-head login-card">
          <div className="login-brand">
            <CayeMark size={36} />
          </div>
          <span className="login-eyebrow">Channels</span>
          <h1 className="login-heading">Where guests reach you</h1>
          <p className="login-sub">
            Connect one channel and Caye starts catching messages right away — the rest can wait.
          </p>
        </div>

        {workspaceId ? (
          <ChannelsPanel workspaceId={workspaceId} variant="onboarding" />
        ) : (
          <div className="login-error">
            Missing workspace — open this link again from Caye&apos;s WhatsApp message.
          </div>
        )}

        <div className="cx-foot">
          <button
            className="login-oauth cx-cta"
            onClick={() => router.push(workspaceId ? `/dashboard/${workspaceId}` : "/login")}
          >
            Go to dashboard
            <span className="arrow" aria-hidden>→</span>
          </button>
          <p className="cx-skip">Nothing here is required — connect the rest anytime from Settings.</p>
        </div>
      </div>
    </div>
  )
}
