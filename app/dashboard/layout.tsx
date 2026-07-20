import type { Metadata } from "next"

// The actual dashboard shell lives in [workspaceId]/layout.tsx (a client
// component — can't export metadata there). This parent just adds the
// noindex directive over the whole authenticated back-office subtree.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children
}
