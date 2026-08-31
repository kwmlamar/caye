import 'server-only'
import type { Tool } from '../../types'
import { runJobSearchInspection } from '@/app/api/caye/job-search-inspect/route'
import { recordJobSearchAnswer } from '../write-low/record-job-search-answer'

type Input = {
  application_id?: string
  question?: string
  answer?: string
}

/**
 * Founder-only, no-submission inspection of prepared job applications.
 *
 * This deliberately bypasses the generic trigger_cron surface: inspection
 * only reads public ATS form metadata, resolves fields from verified founder
 * facts/artifacts, and writes internal readiness/blocker state. It cannot
 * submit an application or contact an employer, so asking the founder for a
 * second confirmation would be UI friction rather than a safety control.
 *
 * When the founder has just answered one of the unresolved questions, the
 * same conversational tool can persist that explicit answer before
 * re-inspecting. This closes the old loop where Caye understood "Yes" in
 * chat but never moved it into the canonical job-search fact/application
 * state, then asked for the same answer again.
 */
export const inspectJobSearchApplications: Tool<Input> = {
  name: 'inspect_job_search_applications',
  description:
    'Inspect founder job applications and resolve Greenhouse readiness. If the founder has just answered an unresolved required application question, call this tool immediately with application_id, the exact question text you previously surfaced, and the founder\'s explicit answer. Persist the answer and re-inspect in the same call. Do not ask the founder to confirm an internal answer write a second time. If no answer is being supplied, omit all three fields to inspect current NEEDS_HUMAN applications. This tool never submits or contacts an employer.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      application_id: { type: 'string' },
      question: { type: 'string' },
      answer: { type: 'string' },
    },
  },

  async execute(args, ctx) {
    try {
      const hasAnyAnswerArg = Boolean(args.application_id || args.question || args.answer)
      if (hasAnyAnswerArg) {
        if (!args.application_id || !args.question || !args.answer) {
          return { ok: false, error: 'application_id, question, and answer must all be supplied together.' }
        }
        return recordJobSearchAnswer.execute(
          { application_id: args.application_id, question: args.question, answer: args.answer },
          ctx,
        )
      }

      const result = await runJobSearchInspection()
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not inspect job-search applications' }
    }
  },
}
