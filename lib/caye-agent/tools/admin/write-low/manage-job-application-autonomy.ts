import 'server-only'
import {
  getStandingAuthorization,
  grantStandingAuthorization,
  pauseStandingAuthorization,
  resumeStandingAuthorization,
  revokeStandingAuthorization,
  updateStandingPolicy,
  standingAuthorizationDenial,
} from '@/lib/job-search/standing-authorization'
import { getExecutionRolloutSettings } from '@/lib/job-search/execution/rollout'
import type { Tool } from '../../types'

/**
 * Conversational control over the founder's standing job-search authority.
 *
 * These replace the old activation ritual — "enable live application
 * automation" (yes) / "turn off dry-run mode" (yes) / "authorize this batch"
 * (yes) — with the thing the founder actually meant: "start applying for jobs
 * for me."
 *
 * None of them are gateAdminHighRisk-wrapped, and that is a deliberate,
 * bounded decision. The founder's instruction here IS the authorization; a
 * confirmation turn would only ask them to repeat a sentence they just said
 * unambiguously. What keeps this safe is that the grant does not itself submit
 * anything: every resulting application still passes the full preflight and the
 * submission authority boundary, which independently re-proves this policy from
 * the database immediately before each click. The emergency kill switch and
 * the staged rollout cap both still outrank it.
 *
 * The safety-positive directions (pause, stop) are immediate for the same
 * reason pause_job_search is: making someone confirm a stop is an anti-pattern.
 */

interface StartInput {
  instruction: string
  max_applications_per_day?: number
  min_fit_score?: number
  job_families?: string[]
}

export const startJobApplications: Tool<StartInput> = {
  name: 'start_job_applications',
  description:
    'Grant standing authorization for Caye to autonomously apply to qualified jobs, and turn on live submission. Use when the founder says "start applying for jobs for me", "apply to jobs on my behalf", or similar. Records their instruction as the authorization. After this, individual applications inside the policy need no further confirmation. Report the policy summary back once.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      instruction: { type: 'string', description: "The founder's own instruction, verbatim, recorded as authorization evidence." },
      max_applications_per_day: { type: 'number', description: 'Daily ceiling on real submissions. Defaults to 150. This is a ceiling, never a quota.' },
      min_fit_score: { type: 'number', description: 'Minimum fit score to apply. Defaults to 70.' },
      job_families: { type: 'array', items: { type: 'string' }, description: 'Optional title keywords to restrict to, e.g. ["software engineer"]. Empty means any qualified role.' },
    },
    required: ['instruction'],
  },

  async execute(args) {
    try {
      const granted = await grantStandingAuthorization({
        actor: 'founder',
        instruction: args.instruction,
        maxApplicationsPerDay: args.max_applications_per_day,
        minFitScore: args.min_fit_score,
        allowedJobFamilies: args.job_families,
      })
      if (!granted.ok) return { ok: false, error: granted.error }

      // Surface the real operating ceiling. The founder asking for 150/day
      // while the staged rollout cap is 1 should be told that plainly rather
      // than discovering it from a quiet single submission.
      const rollout = await getExecutionRolloutSettings()
      const effectiveToday = Math.min(granted.policy.maxApplicationsPerDay, rollout.dailySubmissionCap)

      return {
        ok: true,
        data: {
          standing_authorization: 'active',
          max_applications_per_day: granted.policy.maxApplicationsPerDay,
          min_fit_score: granted.policy.minFitScore,
          job_families: granted.policy.allowedJobFamilies.length ? granted.policy.allowedJobFamilies : 'any qualified role',
          effective_ceiling_today: effectiveToday,
          staged_rollout_cap: rollout.dailySubmissionCap,
          rollout_note: effectiveToday < granted.policy.maxApplicationsPerDay
            ? `The staged rollout cap is currently ${rollout.dailySubmissionCap}/day and takes precedence until the first real submissions are confirmed. Tell the founder this plainly.`
            : null,
          interrupts_for: [
            'a required question with no verified answer',
            'a CAPTCHA, login wall, or identity check',
            'a submission whose outcome is uncertain',
          ],
          note: 'Standing authorization is active. Do NOT ask the founder to confirm individual applications or batches from here on.',
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not start job applications' }
    }
  },
}

interface PauseInput { reason?: string }

export const pauseJobApplications: Tool<PauseInput> = {
  name: 'pause_job_applications',
  description: 'Immediately pause autonomous job applications while keeping the standing authorization intact. Use for "pause job applications" / "hold off on applying". Resumable with resume_job_applications.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'Optional reason, for the audit log.' } } },

  async execute(args) {
    try {
      await pauseStandingAuthorization(args.reason ?? 'Paused by founder request', 'founder')
      return { ok: true, data: { autonomous_applications: 'paused', note: 'No further applications will be submitted until resumed.' } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not pause job applications' }
    }
  },
}

export const resumeJobApplications: Tool<Record<string, never>> = {
  name: 'resume_job_applications',
  description: 'Resume autonomous job applications after a pause. Use for "resume job applications" / "start applying again". Fails if the standing authorization was stopped outright rather than paused.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const resumed = await resumeStandingAuthorization('founder')
      if (!resumed.ok) return { ok: false, error: resumed.error }
      return { ok: true, data: { autonomous_applications: 'active' } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not resume job applications' }
    }
  },
}

interface StopInput { reason?: string }

export const stopJobApplications: Tool<StopInput> = {
  name: 'stop_job_applications',
  description: 'Revoke the standing job-search authorization entirely and turn live submission back off. Use for "stop applying for jobs". Restarting afterwards requires a fresh start_job_applications instruction.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'Optional reason, for the audit log.' } } },

  async execute(args) {
    try {
      await revokeStandingAuthorization('founder', args.reason ?? 'Stopped by founder request')
      return { ok: true, data: { standing_authorization: 'revoked', live_submission: 'disabled' } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not stop job applications' }
    }
  },
}

interface PolicyInput {
  min_fit_score?: number
  max_applications_per_day?: number
  job_families?: string[]
  excluded_employers?: string[]
}

export const setJobApplicationPolicy: Tool<PolicyInput> = {
  name: 'set_job_application_policy',
  description:
    'Adjust the standing job-application policy. Use for "don\'t apply to jobs below 80", "apply to up to 150 qualified jobs per day", "only apply to software engineering jobs", "never apply to <company>". Takes effect before the next submission.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      min_fit_score: { type: 'number', description: 'Minimum fit score, 0-100.' },
      max_applications_per_day: { type: 'number', description: 'Daily ceiling on real submissions.' },
      job_families: { type: 'array', items: { type: 'string' }, description: 'Title keywords to restrict to. Pass an empty array to allow any qualified role.' },
      excluded_employers: { type: 'array', items: { type: 'string' }, description: 'Employers never to apply to.' },
    },
  },

  async execute(args) {
    try {
      const updated = await updateStandingPolicy({
        minFitScore: args.min_fit_score,
        maxApplicationsPerDay: args.max_applications_per_day,
        allowedJobFamilies: args.job_families,
        excludedEmployers: args.excluded_employers,
      }, 'founder')
      if (!updated.ok) return { ok: false, error: updated.error }
      return {
        ok: true,
        data: {
          min_fit_score: updated.policy.minFitScore,
          max_applications_per_day: updated.policy.maxApplicationsPerDay,
          job_families: updated.policy.allowedJobFamilies,
          excluded_employers: updated.policy.excludedEmployers,
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not update the job-application policy' }
    }
  },
}

export const getJobApplicationAutonomy: Tool<Record<string, never>> = {
  name: 'get_job_application_autonomy',
  description: 'Report the current standing job-application authorization and policy: active or not, thresholds, caps, and why it is not running if it is not. Read-only. Use before answering "are you applying to jobs?".',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const [policy, rollout] = await Promise.all([getStandingAuthorization(), getExecutionRolloutSettings()])
      const denial = standingAuthorizationDenial(policy)
      return {
        ok: true,
        data: {
          active: denial === null,
          not_running_because: denial,
          authorized_at: policy.authorizedAt,
          authorized_by: policy.authorizedBy,
          founder_instruction: policy.evidence.instruction ?? null,
          min_fit_score: policy.minFitScore,
          max_applications_per_day: policy.maxApplicationsPerDay,
          job_families: policy.allowedJobFamilies,
          excluded_employers: policy.excludedEmployers,
          paused_reason: policy.pausedReason,
          staged_rollout_cap: rollout.dailySubmissionCap,
          emergency_paused: rollout.emergencyPaused,
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read job-application autonomy state' }
    }
  },
}
