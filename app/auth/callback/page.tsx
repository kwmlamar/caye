"use client"

import { Suspense, useEffect, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { getSupabase, claimWorkspace } from "@/lib/supabase"

function CallbackFallback() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--tc-bg-app)' }}>
      <p style={{ color: 'var(--tc-ink-mute)', fontSize: 13 }}>Signing you in…</p>
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackFallback />}>
      <AuthCallbackInner />
    </Suspense>
  )
}

function AuthCallbackInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Present when /login was reached via a "claim my dashboard" link for a
  // workspace that already exists from a WhatsApp-first signup — see
  // app/login/page.tsx and lib/onboarding-whatsapp.ts.
  const claimWorkspaceId = searchParams.get('ws')
  const processed = useRef(false)

  useEffect(() => {
    const client = getSupabase()

    async function routeAfterAuth(userId: string) {
      if (claimWorkspaceId) {
        // Discovery already finished for this workspace over WhatsApp —
        // this sign-in is only attaching a dashboard login, not creating
        // a new workspace. Skip the system_prompt check entirely.
        await claimWorkspace(claimWorkspaceId, userId)
        router.push(`/dashboard/${claimWorkspaceId}`)
        return
      }

      // Onboarding (the discovery chat) is only "done" once it has written
      // a system prompt to workspace_ai_config. New sign-ins with no config
      // yet go through onboarding first instead of landing straight on the
      // dashboard with an unconfigured Caye.
      const { data: aiConfig } = await client
        .from("workspace_ai_config")
        .select("system_prompt")
        .eq("workspace_id", userId)
        .maybeSingle()

      if (aiConfig?.system_prompt) {
        router.push(`/dashboard/${userId}`)
      } else {
        router.push(`/onboarding?ws=${userId}`)
      }
    }

    const { data: { subscription } } = client.auth.onAuthStateChange(
      async (event, session) => {
        if ((event !== "SIGNED_IN" && event !== "INITIAL_SESSION") || !session || processed.current) return
        processed.current = true

        const user = session.user

        // Ensure workspace_members record exists. The DB's
        // handle_new_auth_user() trigger already does this for a brand
        // new auth user (creating their own throwaway workspace) — this
        // upsert is a no-op in that case, and is what actually matters
        // for a returning user signing back into their existing workspace.
        await client.from("workspace_members").upsert({
          workspace_id: user.id,
          user_id: user.id,
          role: "owner",
        }, { onConflict: "workspace_id,user_id" })

        await routeAfterAuth(user.id)
      }
    )

    const fallbackTimer = setTimeout(async () => {
      if (processed.current) return
      const { data: { session } } = await client.auth.getSession()
      if (session) {
        processed.current = true
        await routeAfterAuth(session.user.id)
      } else {
        router.push("/login")
      }
    }, 5000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(fallbackTimer)
    }
  }, [router, claimWorkspaceId])

  return <CallbackFallback />
}
