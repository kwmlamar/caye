import type { Metadata } from "next"

// The actual dashboard shell lives in [workspaceId]/layout.tsx (a client
// component — can't export metadata there). This parent just adds the
// noindex directive over the whole authenticated back-office subtree.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        /* Caye Direct is already visually directional: founder turns are
           right-aligned bubbles and Caye turns are open left-aligned text.
           Repeating names/marks on every turn adds noise without information. */
        .caye-direct-thread img[src="/caye-logo-icon.png"] {
          display: none !important;
        }
        .caye-direct-thread .caye-working-mark,
        .caye-direct-thread .caye-direct-sender {
          display: none !important;
        }
      `}</style>
      {children}
    </>
  )
}
