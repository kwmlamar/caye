import type { Metadata } from "next"
import ConnectClient from "./ConnectClient"
import { verifyConnectToken } from "@/lib/channels/connect-token"

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; t?: string; only?: string; link_error?: string }>
}) {
  const { ws, t, only, link_error } = await searchParams

  // Signed token is the supported path (Caye texts these). `ws` is still
  // read so links already sitting in someone's chat history from before
  // the token change resolve instead of dead-ending — it grants nothing
  // on its own, since every OAuth initiator now requires a token.
  const verified = t ? verifyConnectToken(t) : null
  const workspaceId = verified?.ok ? verified.workspaceId : (ws ?? null)

  return (
    <ConnectClient
      workspaceId={workspaceId}
      only={only ?? null}
      linkError={link_error ?? (t && !verified?.ok ? verified?.reason ?? null : null)}
    />
  )
}
