import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import {
  buildFounderContextSnapshot,
  invokeFounderReadCapability,
  invokeFounderResearchStartCapability,
} from '@/lib/capabilities/gateway'
import { capabilityCoverage, conversationalCapabilityManifest } from '@/lib/capabilities/control-plane'

function workspaceFromQuery(req: NextRequest): { ok: true; workspaceId: string | null } | { ok: false } {
  if (!req.nextUrl.searchParams.has('workspaceId')) return { ok: true, workspaceId: null }
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return { ok: false }
  return { ok: true, workspaceId }
}

/** GET /api/founder/capabilities[?workspaceId=<uuid>] */
export async function GET(req: NextRequest) {
  const founder = await requireFounder(req)
  if (!founder) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const scope = workspaceFromQuery(req)
  if (!scope.ok) return NextResponse.json({ error: 'workspaceId must be non-empty when provided' }, { status: 400 })
  const snapshot = await buildFounderContextSnapshot(founder.id, scope.workspaceId)
  return NextResponse.json({
    ...snapshot,
    conversationalCapabilities: conversationalCapabilityManifest(),
    directionCoverage: capabilityCoverage(),
  })
}

/**
 * POST /api/founder/capabilities
 * Registered reads use the read-only gateway. The only staged write exposed by
 * this route is research.start, which merely enqueues an existing question.
 */
export async function POST(req: NextRequest) {
  const founder = await requireFounder(req)
  if (!founder) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const input = body as Record<string, unknown>
  if (typeof input.capability !== 'string' || typeof input.version !== 'number') return NextResponse.json({ error: 'capability and version are required' }, { status: 400 })
  if (input.workspaceId !== null && input.workspaceId !== undefined && typeof input.workspaceId !== 'string') return NextResponse.json({ error: 'workspaceId must be a string or null' }, { status: 400 })
  if (input.propertyId !== undefined && typeof input.propertyId !== 'string') return NextResponse.json({ error: 'propertyId must be a string' }, { status: 400 })

  let result
  if (input.capability === 'research.start') {
    if (input.version !== 1 || input.workspaceId !== null || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
      return NextResponse.json({ error: 'research.start requires version 1, workspaceId null, and args.questionId' }, { status: 400 })
    }
    const args = input.args as Record<string, unknown>
    if (Object.keys(args).some((key) => key !== 'questionId') || typeof args.questionId !== 'string' || !args.questionId.trim()) {
      return NextResponse.json({ error: 'research.start accepts only a non-empty questionId' }, { status: 400 })
    }
    result = await invokeFounderResearchStartCapability(founder.id, {
      capability: 'research.start', version: 1, workspaceId: null, args: { questionId: args.questionId.trim() },
    })
  } else {
    result = await invokeFounderReadCapability(founder.id, {
      capability: input.capability,
      version: input.version,
      workspaceId: (input.workspaceId as string | null | undefined) ?? null,
      propertyId: input.propertyId as string | undefined,
      args: input.args,
    })
  }

  return NextResponse.json({
    result,
    conversationalCapabilities: conversationalCapabilityManifest(),
    directionCoverage: capabilityCoverage(),
  })
}
