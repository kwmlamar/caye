/**
 * POST /api/founder/caye-direct/voice/telemetry
 *
 * Founder-only. Receives the browser half of one voice turn's latency
 * breakdown (see lib/caye-voice/client/voice-timeline.ts) and writes it to
 * the same log stream as the server half, so a single turn can be read end
 * to end by grepping one session id.
 *
 * Accepts timings only. The client never sends transcript or reply text,
 * and this route would not persist it if it did — nothing here writes to
 * the database.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'

/** Bound on what a single turn can report, so a malformed or hostile body can't flood the logs. */
const MAX_MARKS = 64

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { workspaceId, sessionId, backend, marks, metrics } = (body ?? {}) as {
    workspaceId?: string
    sessionId?: string
    backend?: string | null
    marks?: unknown
    metrics?: unknown
  }
  if (!workspaceId || !sessionId) {
    return NextResponse.json({ error: 'workspaceId and sessionId are required' }, { status: 400 })
  }

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Re-shape rather than echo: only known-numeric stage timings survive, so
  // whatever the client sent, what reaches the logs is timings.
  const safeMarks = Array.isArray(marks)
    ? marks
        .slice(0, MAX_MARKS)
        .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>) : {}))
        .filter((m) => typeof m.stage === 'string' && typeof m.atMs === 'number')
        .map((m) => ({ stage: String(m.stage).slice(0, 40), atMs: Math.round(m.atMs as number) }))
    : []

  const safeMetrics =
    metrics && typeof metrics === 'object'
      ? Object.fromEntries(
          Object.entries(metrics as Record<string, unknown>)
            .filter(([, v]) => v === null || typeof v === 'number')
            .map(([k, v]) => [k.slice(0, 40), v === null ? null : Math.round(v as number)])
        )
      : {}

  console.log(
    '[caye-voice] client_timeline',
    JSON.stringify({
      workspaceId,
      sessionId,
      backend: typeof backend === 'string' ? backend.slice(0, 40) : null,
      metrics: safeMetrics,
      marks: safeMarks,
      at: new Date().toISOString(),
    })
  )

  return NextResponse.json({ ok: true })
}
