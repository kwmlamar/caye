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
// surface is unavoidable even in a WhatsApp-first product.
export default function ConnectClient({ workspaceId }: Props) {
  const router = useRouter()

  return (
    <div className="login-root login-dark" style={{ alignItems: "flex-start", paddingTop: "8vh" }}>
      <div style={{
        background: "var(--tc-bg-soft, #fff)",
        borderRadius: 20, overflow: "hidden",
        boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
        width: "100%", maxWidth: 560,
        margin: "0 auto",
      }}>
        <div style={{
          background: "#0b1419", padding: "20px 24px",
          display: "flex", alignItems: "center", gap: 14,
        }}>
          <CayeMark size={40} />
          <div>
            <p style={{ fontSize: 15, fontWeight: 600, color: "#fff", letterSpacing: "-0.01em" }}>
              Connect your channels
            </p>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
              So Caye can start catching messages for you
            </p>
          </div>
        </div>

        <div style={{ padding: "20px 24px", maxHeight: "65vh", overflowY: "auto" }}>
          {workspaceId ? (
            <ChannelsPanel workspaceId={workspaceId} />
          ) : (
            <p style={{ fontSize: 13, color: "var(--tc-ink-mute, #5e5a52)" }}>
              Missing workspace — open this link again from Caye&apos;s WhatsApp message.
            </p>
          )}
        </div>

        <div style={{ padding: "16px 24px 24px", borderTop: "1px solid var(--tc-line, rgba(11,20,25,0.08))" }}>
          <button
            onClick={() => router.push(workspaceId ? `/dashboard/${workspaceId}` : "/login")}
            style={{
              width: "100%", padding: "13px 20px",
              background: "#0b1419", color: "#fff",
              border: "none", borderRadius: 10, cursor: "pointer",
              fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}
          >
            Go to dashboard
            <span style={{ fontSize: 16 }}>→</span>
          </button>
          <p style={{ textAlign: "center", fontSize: 11.5, color: "var(--tc-ink-faint, #9aa3ac)", marginTop: 10 }}>
            You can connect the rest later — nothing here is required to continue.
          </p>
        </div>
      </div>
    </div>
  )
}
