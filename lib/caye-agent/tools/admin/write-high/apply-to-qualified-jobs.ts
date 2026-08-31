import 'server-only'
import { grantBatchAuthorization, runAuthorizedBatch, selectBatchCandidates, MAX_BATCH_CONCURRENCY } from '@/lib/job-search/execution/batch'
import type { Tool } from '../../types'

interface ApplyToQualifiedJobsInput {
  max_applications: number
  min_score?: number
  concurrency?: number
  window_minutes?: number
}

/**
 * The bounded autonomous batch: "apply to up to N qualified Greenhouse jobs".
 *
 * This is the tool that stops confirmation from becoming a part-time job. It
 * is HIGH-RISK and gateAdminHighRisk-wrapped, so the founder confirms ONCE -
 * and that single confirmation is bound, through the gate's stable args key,
 * to the exact count, score floor, and window they agreed to. Inside that
 * envelope the worker submits without asking again.
 *
 * What the envelope does NOT buy: it cannot lower a quality or safety
 * threshold. Every application still goes through the full preflight and the
 * submission authority boundary, an unresolved consequential question still
 * escalates rather than being guessed, and an UNCERTAIN result still stops the
 * whole batch. The authorization bounds how many attempts may happen without
 * asking - never what is allowed to happen.
 */
export const applyToQualifiedJobs: Tool<ApplyToQualifiedJobsInput> = {
  name: 'apply_to_qualified_jobs',
  description:
    'Submit real applications to up to N already-PREPARED, qualified Greenhouse jobs under one bounded founder authorization. HIGH-RISK: this sends real applications to real employers. Confirmation is enforced in code — the first call only stages the batch and reports exactly what would be submitted; relay that summary and call again with identical arguments once the founder confirms in a NEW message. Use for "apply to the best qualified jobs" / "apply to up to 5 more" requests.',
  risk: 'high',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      max_applications: { type: 'number', description: 'Maximum real applications to submit in this batch (at least 1).' },
      min_score: { type: 'number', description: 'Minimum fit score required. Defaults to 70, the standard qualification bar.' },
      concurrency: { type: 'number', description: `Concurrent browser workers, 1-${MAX_BATCH_CONCURRENCY}. Defaults to 1.` },
      window_minutes: { type: 'number', description: 'How long the authorization stays valid. Defaults to 120.' },
    },
    required: ['max_applications'],
  },

  async execute(args) {
    try {
      const minScore = args.min_score ?? 70

      const granted = await grantBatchAuthorization({
        provider: 'greenhouse',
        maxApplications: args.max_applications,
        minScore,
        windowMinutes: args.window_minutes,
        actor: 'founder',
      })
      if (!granted.ok) return { ok: false, error: granted.error }

      const outcome = await runAuthorizedBatch(granted.authorization.id, { concurrency: args.concurrency })

      return {
        ok: true,
        data: {
          authorization_id: granted.authorization.id,
          expires_at: granted.authorization.expiresAt,
          max_applications: granted.authorization.maxApplications,
          min_score: minScore,
          attempted: outcome.attempted,
          submitted: outcome.submitted,
          submission_uncertain: outcome.uncertain,
          needs_human: outcome.needsHuman,
          failed: outcome.failed,
          skipped: outcome.skipped,
          stopped_early: outcome.stoppedEarly,
          results: outcome.results,
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not run the authorized batch' }
    }
  },
}

interface PreviewInput {
  max_applications?: number
  min_score?: number
}

/**
 * Read-only preview of what a batch WOULD submit.
 *
 * Exists so the founder can see the actual list before authorizing anything.
 * "Apply to 20 jobs" is a very different decision when you can see which 20.
 */
export const previewQualifiedJobs: Tool<PreviewInput> = {
  name: 'preview_qualified_jobs',
  description: 'Show which PREPARED Greenhouse applications would be submitted by a batch, with company, title and fit score. Read-only — submits nothing. Use for "show me today\'s job pipeline" / "what would you apply to" requests.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      max_applications: { type: 'number', description: 'How many to preview. Defaults to 20.' },
      min_score: { type: 'number', description: 'Minimum fit score. Defaults to 70.' },
    },
  },

  async execute(args) {
    try {
      const candidates = await selectBatchCandidates(
        {
          id: 'preview',
          provider: 'greenhouse',
          maxApplications: args.max_applications ?? 20,
          minScore: args.min_score ?? 70,
          allowedJobFamilies: [],
          consumedCount: 0,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          revokedAt: null,
        },
        args.max_applications ?? 20,
      )
      return {
        ok: true,
        data: {
          qualified_count: candidates.length,
          applications: candidates.map((c) => ({ application_id: c.applicationId, company: c.company, title: c.title, fit_score: c.fitScore })),
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not preview qualified jobs' }
    }
  },
}
