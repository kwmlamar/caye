import { SERVICE_BUSINESS_QUESTIONS } from "@/lib/onboarding"
import OnboardingClient from "./OnboardingClient"

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>
}) {
  const { ws } = await searchParams
  return <OnboardingClient questions={SERVICE_BUSINESS_QUESTIONS} workspaceIdHint={ws} />
}
