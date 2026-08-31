'use client'

/**
 * Legacy compatibility shim.
 *
 * Caye used to maintain a separate `/m/:workspaceId` dashboard and this
 * component automatically pushed phone-sized browsers into it. The current
 * dashboard is the canonical UI on every viewport, so automatic viewport
 * routing is intentionally retired. Keep the component as a no-op until all
 * historical imports disappear naturally.
 */
export default function ViewportRedirect(_props: {
  mode: 'toMobile' | 'toDesktop'
  workspaceId: string
}) {
  return null
}
