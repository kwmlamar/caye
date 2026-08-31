import 'server-only'
import type { Tool } from '../../types'
import { inspectApplicationForHumanAssist, runJobSearchInspection } from '@/app/api/caye/job-search-inspect/route'
import { recordJobSearchAnswer } from '../write-low/record-job-search-answer'

type Input = {
  application_id?: string
  question?: string
  answer?: string
}

/**
 * Founder-only, no-submission inspection of job applications.
 *
 * Supplying application_id alone inspects that exact application, including a
 * PREPARED application selected for final founder review. Supplying all three
 * fields persists an explicit founder answer and then re-inspects. With no
 * arguments, the tool scans the current NEEDS_HUMAN queue.
 *
 * This tool never submits or contacts an employer.
 */
export const inspectJobSearchApplications: Tool<Input> = {
  name: 'inspect_job_search_applications',
  description:
    'Inspect founder job applications and resolve Greenhouse readiness. To review one exact application, including a PREPARED application before submission, call with application_id only. If the founder has answered an unresolved required question, call with application_id, the exact question text, and the explicit answer to persist it and re-inspect. With no arguments, inspect current NEEDS_HUMAN applications. This tool never submits or contacts an employer.',
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
      const hasQuestion = Boolean(args.question)
      const hasAnswer = Boolean(args.answer)

      if (hasQuestion || hasAnswer) {
        if (!args.application_id || !args.question || !args.answer) {
          return { ok: false, error: 'application_id, question, and answer must all be supplied together when recording an answer.' }
        }
        return recordJobSearchAnswer.execute(
          { application_id: args.application_id, question: args.question, answer: args.answer },
          ctx,
        )
      }

      if (args.application_id) {
        const result = await inspectApplicationForHumanAssist(args.application_id)
        return { ok: true, data: result }
      }

      const result = await runJobSearchInspection()
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not inspect job-search applications' }
    }
  },
}
