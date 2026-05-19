import { TOUR_OPERATOR_QUESTIONS } from "@/lib/onboarding"
import OnboardingClient from "./OnboardingClient"

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>
}) {
  const { ws } = await searchParams
  return <OnboardingClient questions={TOUR_OPERATOR_QUESTIONS} workspaceIdHint={ws} />
}
