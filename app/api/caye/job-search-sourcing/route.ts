/**
 * GET /api/caye/job-search-sourcing (CAY-192)
 *
 * Daily job-search cron: source -> normalize -> dedupe -> score -> queue.
 * Mirrors the shape of every other cron in this repo (see
 * app/api/caye/outreach-sourcing-scan/route.ts) — same CRON_SECRET auth,
 * same exported run() function registered in lib/caye-agent/tools/admin/
 * cron-registry.ts so the founder can inspect/manually trigger it via
 * get_cron_health / trigger_cron exactly like every other cron.
 *
 * NOT YET REGISTERED with an external scheduler (cron-job.org) — that is
 * a real production side effect outside this PR's authority (per
 * Products/Caye/CLAUDE.md engineering rules) and is called out as a
 * required manual follow-up step in the PR description. Until then this
 * route only runs when triggered manually (trigger_cron) or via a direct
 * authenticated request.
 *
 * Deliberately does NOT run the apply/prepare phase — sourcing/scoring
 * and application preparation are kept as two separate concerns so a
 * founder can inspect a fresh queue before any application artifacts get
 * generated. Preparing applications for the current queue, respecting
 * remaining daily capacity and the pause flag, is intentionally a
 * separate follow-up (see PR description) rather than folded silently
 * into this route.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runIngestPipeline } from '@/lib/job-search/ingest'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const stats = await runJobSearchSourcing()
    return NextResponse.json({ status: 'completed', stats })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function runJobSearchSourcing(): Promise<Record<string, unknown>> {
  const stats = await runIngestPipeline()
  return { ...stats }
}
