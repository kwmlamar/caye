import OnboardingClient from "./OnboardingClient"

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>
}) {
  const { ws } = await searchParams
  return <OnboardingClient workspaceIdHint={ws} />
}
