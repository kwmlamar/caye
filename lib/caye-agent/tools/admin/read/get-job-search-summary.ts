import 'server-only'
import { getDailySummary } from '@/lib/job-search/summary'
import type { Tool } from '../../types'

/**
 * CAY-192 Phase 7 founder UX: "Find me jobs today" / "How many did you
 * apply to?" answer this via the live, already-wired Admin Shell tool
 * surface (WhatsApp + Admin Shell dashboard chat) — this is what actually
 * answers the founder in conversation today.
 *
 * The CAY-27 capability gateway also registers the same read as
 * `job_search.summary` (lib/capabilities/job-search-summary.ts). Be precise
 * about what "wired" means for that path (audited 2026-08-28, PR #196):
 *   - Direct HTTP: LIVE today. A founder-authenticated
 *     `POST /api/founder/capabilities` with `{ capability: "job_search.summary" }`
 *     genuinely executes and returns real data right now — this is not
 *     inert or unreachable.
 *   - MCP transport: genuinely inert. `job_search.summary` is not present
 *     in CAYE_MCP_TOOLS / CAPABILITY_BY_TOOL (lib/mcp/protocol.ts), so no
 *     MCP client can reach it.
 *   - Conversational/LLM agent loop: not wired. No chat surface currently
 *     lets the model choose to call this capability mid-conversation — the
 *     Admin Shell tool above is what the agent actually calls.
 * Don't read "not wired into a live agent loop" as "unreachable" — the
 * gateway is a second, independently-authorized (requireFounder) HTTP path
 * to the same underlying data, live in parallel with this tool, not a
 * future placeholder.
 */
export const getJobSearchSummary: Tool<Record<string, never>> = {
  name: 'get_job_search_summary',
  description:
    'Get today\'s job-search pipeline summary: roles sourced, qualified, needing founder review, submitted, and rejected (with reasons), plus whether the pipeline is paused. Call this for "find me jobs today", "how many did you apply to", "what needs me" type questions.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const summary = await getDailySummary()
      return { ok: true, data: summary }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read job-search summary' }
    }
  },
}
