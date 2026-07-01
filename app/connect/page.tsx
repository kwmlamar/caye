import ConnectClient from "./ConnectClient"

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>
}) {
  const { ws } = await searchParams
  return <ConnectClient workspaceId={ws ?? null} />
}
