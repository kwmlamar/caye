import { NextResponse } from 'next/server'
import { mcpProtectedResourceMetadata } from '@/lib/mcp/oauth'

export const runtime = 'nodejs'

/** RFC 9728 protected-resource discovery for OAuth-aware MCP clients. */
export function GET() {
  const metadata = mcpProtectedResourceMetadata()
  if (!metadata) {
    return NextResponse.json({ error: 'OAuth is not configured' }, { status: 503 })
  }
  return NextResponse.json(metadata, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
