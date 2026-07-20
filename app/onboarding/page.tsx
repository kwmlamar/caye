import type { Metadata } from "next"
import { encodeSignupCode } from "@/lib/onboarding-whatsapp"
import OnboardingClient from "./OnboardingClient"

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>
}) {
  const { ws } = await searchParams
  return (
    <OnboardingClient
      workspaceIdHint={ws}
      signupCode={ws ? encodeSignupCode(ws) : undefined}
    />
  )
}
