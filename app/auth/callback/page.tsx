"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { getSupabase } from "@/lib/supabase"

export default function AuthCallbackPage() {
  const router = useRouter()
  const processed = useRef(false)

  useEffect(() => {
    const client = getSupabase()

    const { data: { subscription } } = client.auth.onAuthStateChange(
      async (event, session) => {
        if ((event !== "SIGNED_IN" && event !== "INITIAL_SESSION") || !session || processed.current) return
        processed.current = true

        const user = session.user

        // Ensure workspace_members record exists
        await client.from("workspace_members").upsert({
          workspace_id: user.id,
          user_id: user.id,
          role: "owner",
        }, { onConflict: "workspace_id,user_id" })

        router.push(`/dashboard/${user.id}`)
      }
    )

    const fallbackTimer = setTimeout(async () => {
      if (processed.current) return
      const { data: { session } } = await client.auth.getSession()
      if (session) {
        processed.current = true
        router.push(`/dashboard/${session.user.id}`)
      } else {
        router.push("/login")
      }
    }, 5000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(fallbackTimer)
    }
  }, [router])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--tc-bg-app)' }}>
      <p style={{ color: 'var(--tc-ink-mute)', fontSize: 13 }}>Signing you in…</p>
    </div>
  )
}
