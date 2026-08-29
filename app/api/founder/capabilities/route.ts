import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import {
  buildFounderContextSnapshot,
  founderCapabilityManifest,
  invokeFounderReadCapability,
} from '@/lib/capabilities/gateway'

function workspaceFromQuery(req: NextRequest): { ok: true; workspaceId: string | null } | { ok: false } {
  if (!req.nextUrl.searchParams.has('workspaceId')) return { ok: true, workspaceId: null }
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return { ok: false }
  return { ok: true, workspaceId }
}

/**
 * GET /api/founder/capabilities[?workspaceId=<uuid>]
 *
 * Returns the allowlisted semantic manifest plus a compact founder context
 * snapshot. Missing workspaceId intentionally means operator/global scope.
 */
export async function GET(req: NextRequest) {
  const founder = await requireFounder(req)
  if (!founder) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const scope = workspaceFromQuery(req)
  if (!scope.ok) {
    return NextResponse.json({ error: 'workspaceId must be non-empty when provided' }, { status: 400 })
  }

  const snapshot = await buildFounderContextSnapshot(founder.id, scope.workspaceId)
  return NextResponse.json(snapshot)
}

/**
 * POST /api/founder/capabilities
 * { capability, version, workspaceId, args? }
 *
 * V0.1 invokes only registered read-only capabilities. Authenticated founder
 * identity is injected server-side; a caller cannot provide or impersonate it.
 */
export async function POST(req: NextRequest) {
  const founder = await requireFounder(req)
  if (!founder) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const input = body as Record<string, unknown>
  if (typeof input.capability !== 'string' || typeof input.version !== 'number') {
    return NextResponse.json({ error: 'capability and version are required' }, { status: 400 })
  }
  if (input.workspaceId !== null && input.workspaceId !== undefined && typeof input.workspaceId !== 'string') {
    return NextResponse.json({ error: 'workspaceId must be a string or null' }, { status: 400 })
  }
  if (input.propertyId !== undefined && typeof input.propertyId !== 'string') {
    return NextResponse.json({ error: 'propertyId must be a string' }, { status: 400 })
  }

  const result = await invokeFounderReadCapability(founder.id, {
    capability: input.capability,
    version: input.version,
    workspaceId: (input.workspaceId as string | null | undefined) ?? null,
    propertyId: input.propertyId as string | undefined,
    args: input.args,
  })

  return NextResponse.json({
    result,
    capabilities: founderCapabilityManifest(),
  })
}
