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
        /* Caye Direct already labels assistant turns in text. Repeating the
           brand mark beside every reply (and again while thinking) adds noise
           without carrying information, so keep the transcript typographic. */
        .caye-direct-thread img[src="/caye-logo-icon.png"] {
          display: none !important;
        }
        .caye-direct-thread .caye-working-mark {
          display: none !important;
        }
      `}</style>
      {children}
    </>
  )
}
