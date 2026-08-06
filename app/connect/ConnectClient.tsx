"use client"

import ChannelsPanel from "@/components/settings/ChannelsPanel"
import { CayeMark } from "@/components/brand/CayeMark"

interface Props {
  workspaceId: string | null
  /** A single channel to execute, e.g. "whatsapp". Null renders the full grid. */
  only: string | null
  /** Set when the link that brought them here was expired or invalid. */
  linkError: string | null
}

const LINK_ERROR_COPY: Record<string, string> = {
  expired: "That link has expired. Message Caye on WhatsApp and she'll send a fresh one.",
  bad_signature: "That link isn't valid. Message Caye on WhatsApp for a new one.",
  malformed: "That link isn't valid. Message Caye on WhatsApp for a new one.",
  channel_mismatch: "That link was for a different channel. Ask Caye to send the right one.",
}

// Reached from a link Caye texted. Meta's Embedded Signup is the one flow
// that genuinely cannot be a deep link — it's the Facebook JS SDK opening
// a popup, so it needs a real page. Every other channel is a naked link
// straight to its OAuth initiator and never lands here.
//
// Which is why this renders ONE card when `only` is set. A menu would hand
// back the choice the walkthrough exists to remove, and invite wandering
// into a channel whose prerequisites aren't met — losing the step they
// actually came for. The full grid still lives in dashboard Settings,
// where reviewing everything is the actual job.
export default function ConnectClient({ workspaceId, only, linkError }: Props) {
  const single = only === "whatsapp" ? "whatsapp" : null

  return (
    <div className="login-root login-dark cx-root">
      <div className="cx-shell">
        <div className="cx-head login-card">
          <div className="login-brand">
            <CayeMark size={36} />
          </div>
          <span className="login-eyebrow">{single ? "WhatsApp" : "Channels"}</span>
          <h1 className="login-heading">
            {single ? "Connect your WhatsApp Business" : "Where guests reach you"}
          </h1>
          <p className="login-sub">
            {single
              ? "Takes about a minute. Caye starts picking up guest messages the moment it's done."
              : "Connect one channel and Caye starts catching messages right away."}
          </p>
        </div>

        {linkError && (
          <div className="login-error">
            {LINK_ERROR_COPY[linkError] ??
              "That link didn't work. Message Caye on WhatsApp and she'll send a new one."}
          </div>
        )}

        {workspaceId ? (
          <ChannelsPanel workspaceId={workspaceId} variant="onboarding" only={single} />
        ) : (
          !linkError && (
            <div className="login-error">
              Missing workspace — open this link again from Caye&apos;s WhatsApp message.
            </div>
          )
        )}

        {/* No "go to dashboard" here on purpose. Mid-walkthrough the next
            step is back in WhatsApp, where Caye's follow-up is already
            waiting — a dashboard button drops them somewhere with no idea
            what they were doing. */}
        <div className="cx-foot">
          <p className="cx-skip">
            Once it&apos;s connected, head back to WhatsApp — Caye picks it up from there.
          </p>
        </div>
      </div>
    </div>
  )
}
