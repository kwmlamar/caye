'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

const MOBILE_QUERY = '(max-width: 767px)'

/**
 * Bidirectional viewport router.
 *
 * - mode="toMobile"  — mounted on the desktop dashboard. If the viewport is
 *   phone-sized, sends the user to the mobile app.
 * - mode="toDesktop" — mounted on the mobile app. If the viewport is wide,
 *   sends the user back to the desktop dashboard.
 *
 * Runs once on mount only — it never yanks the user mid-session on resize.
 * Renders nothing.
 */
export default function ViewportRedirect({
  mode,
  workspaceId,
}: {
  mode: 'toMobile' | 'toDesktop'
  workspaceId: string
}) {
  const router = useRouter()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const isMobile = window.matchMedia(MOBILE_QUERY).matches

    if (mode === 'toMobile' && isMobile) {
      router.replace(`/m/${workspaceId}`)
    } else if (mode === 'toDesktop' && !isMobile) {
      router.replace(`/dashboard/${workspaceId}`)
    }
  }, [mode, workspaceId, router])

  return null
}
