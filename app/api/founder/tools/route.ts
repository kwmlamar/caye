/**
 * GET /api/founder/tools
 *
 * Read-only inventory of every tool in TOOL_REGISTRY, for the founder's
 * "Tools" rail tab — what Caye can actually do, at a glance, instead of
 * reading lib/caye-agent/tools/registry.ts. Strips `execute` and
 * `inputSchema` (implementation detail, not useful in a list view) and
 * keeps name/description/risk/roles/modes.
 *
 * No usage metrics yet — runToolLoop (lib/caye-agent/execute.ts) doesn't
 * persist per-call rows anywhere today, so there's nothing to aggregate.
 * Adding that is a separate follow-up (new table + an insert in the tool
 * loop's execute/catch path), not bundled into this first pass.
 *
 * Note: front-desk tools currently live inline in lib/caye-reply.ts, not
 * in TOOL_REGISTRY (cross-registry unification is #14) — this list is
 * back-office + admin-shell + driver tools only, not the full surface.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { TOOL_REGISTRY } from '@/lib/caye-agent/tools/registry'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const tools = TOOL_REGISTRY.map((t) => ({
    name: t.name,
    description: t.description,
    risk: t.risk,
    roles: t.roles,
    modes: t.modes,
  })).sort((a, b) => a.name.localeCompare(b.name))

  return NextResponse.json({ tools })
}
