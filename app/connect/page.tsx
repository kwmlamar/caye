import type { Metadata } from "next"
import ConnectClient from "./ConnectClient"

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>
}) {
  const { ws } = await searchParams
  return <ConnectClient workspaceId={ws ?? null} />
}
