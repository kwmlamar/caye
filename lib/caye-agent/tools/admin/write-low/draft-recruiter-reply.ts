import 'server-only'
import { draftRecruiterReply } from '@/lib/job-search/response-draft'
import type { Tool } from '../../types'

type Input = { application_id: string }

/**
 * Draft-only, never sends. LOW-RISK because nothing external happens here —
 * see write-high/send-recruiter-reply.ts for the gated send. Refuses (with
 * an explanatory reason) for anything outside the routine categories —
 * compensation, work-authorization ambiguity, offers, and rejections all
 * come back as "requires your judgment" rather than a draft. See
 * lib/job-search/response-classification.ts's FOUNDER_ONLY_CATEGORIES.
 */
export const draftRecruiterReplyTool: Tool<Input> = {
  name: 'draft_recruiter_reply',
  description:
    'Draft a routine reply to a recruiter/ATS response on a job application — acknowledging interest, agreeing to a screen, sharing availability, or sending a requested document. Never sends anything. For anything outside routine categories (offers, rejections, interview scheduling specifics, anything requiring your judgment) this returns a reason instead of a draft. Use before send_recruiter_reply.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    required: ['application_id'],
    properties: { application_id: { type: 'string' } },
  },

  async execute(args) {
    try {
      const result = await draftRecruiterReply(args.application_id)
      if (!result.ok) return { ok: false, error: result.reason }
      return { ok: true, data: result.draft }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not draft a recruiter reply' }
    }
  },
}
