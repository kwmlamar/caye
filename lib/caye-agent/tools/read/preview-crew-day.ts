import 'server-only'

import {
  createBedrockAdapter,
  getBedrockOperatorIdentity,
  getBedrockPolicyConfig,
  BedrockConnectionMissingError,
} from '@/lib/domain-adapters/bedrock'
import { nextCrewDayQuestion, resolveCrewDayPolicy, unconfirmed } from '@/lib/domain-policy'
import { buildCrewDayDraft, findDuplicates, type RosterWorker } from '@/lib/ods/crew-day'
import { resolveJob } from './find-job'
import type { Tool } from '../types'

/**
 * Turn one spoken crew day into the exact rows that would be written — and
 * nothing else.
 *
 * WHY THIS IS SEPARATE FROM log_crew_day
 *
 * Resolution has to happen BEFORE the confirmation, not inside it. If the write
 * tool took "Blue Sky" and "Cyril" and resolved them at execution time, the
 * summary someone approved and the rows that landed would be two different
 * objects, and a roster or project change in between would quietly move hours
 * onto the wrong person or the wrong job. So this tool resolves and returns ids;
 * the write tool takes ids and resolves nothing.
 *
 * It is read-tier because it writes nothing. Its whole job is to make the thing
 * being approved concrete.
 */

export interface PreviewCrewDayInput {
  project: string
  workers: string[]
  start: string
  end: string
  date?: string
  break_minutes?: number
  exceptions?: Array<{ worker: string; start?: string; end?: string }>
}

/** Today in the workspace's own timezone — a crew day is a local calendar day. */
function todayIn(timeZone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

export const previewCrewDay: Tool<PreviewCrewDayInput> = {
  name: 'preview_crew_day',
  description:
    "Resolve a spoken crew day — \"Blue Sky today, me and Cyril, 7 to 4\" — into the exact timesheet " +
    'rows that would be written, without writing anything. ALWAYS call this before log_crew_day, and ' +
    'pass its output through unchanged. If it reports unresolved or ambiguous names, or more than one ' +
    'matching job, ASK which one rather than choosing — a wrong match puts one person\'s hours on ' +
    "another person's pay. It also reports anyone who already has time logged on that job that day.",
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The job, however it was said — "Blue Sky", "the Mann job", a client name.' },
      workers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names as spoken. "me" resolves to the person sending the message.',
      },
      start: { type: 'string', description: 'Start time as said — "7", "7am", "07:00".' },
      end: { type: 'string', description: 'End time as said — "4", "4pm", "16:00".' },
      date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today in the business timezone.' },
      break_minutes: { type: 'number', description: 'Unpaid break. Defaults to 60, which is what every existing entry uses.' },
      exceptions: {
        type: 'array',
        description: 'Per-person differences, e.g. someone who left early.',
        items: {
          type: 'object',
          properties: {
            worker: { type: 'string', description: 'The name, as spoken.' },
            start: { type: 'string', description: 'Different start for this person.' },
            end: { type: 'string', description: 'Different end for this person.' },
          },
          required: ['worker'],
        },
      },
    },
    required: ['project', 'workers', 'start', 'end'],
  },

  async execute(args, ctx) {
    if (!args.workers?.length) return { ok: false, error: 'No workers named for the day.' }

    const adapter = createBedrockAdapter()
    const date = args.date?.trim() || todayIn(ctx.workspaceTimezone)

    let job
    try {
      // The exact resolver find_job and get_job use, so the three tools can
      // never disagree about whether a phrase identifies one job.
      job = await resolveJob(adapter, ctx.workspaceId, args.project)
    } catch (error) {
      if (error instanceof BedrockConnectionMissingError) {
        return { ok: false, error: 'This workspace is not connected to a construction ledger.' }
      }
      return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the ledger.' }
    }
    if (job.match !== 'one') {
      return {
        ok: true,
        data: {
          status: 'needs_review',
          reason: job.match === 'none' ? 'no_matching_job' : 'ambiguous_job',
          candidates: job.candidates,
          note:
            job.match === 'none'
              ? `No active job matches "${args.project}". Ask which job they mean.`
              : `More than one job matches "${args.project}". Ask which one — do not choose.`,
        },
      }
    }

    const project = job.candidates[0]

    let roster: RosterWorker[]
    try {
      const workers = await adapter.listWorkers(ctx.workspaceId, { status: 'active', limit: 200 })
      roster = workers.map((w) => ({ id: w.id, firstName: w.firstName, lastName: w.lastName, status: w.status }))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not read the worker roster.' }
    }

    // "me" means the sender's WORKER row, which is a different thing from the
    // profile a write is attributed to. Omar, Wallace and Jay are profiles and
    // appear in no worker row at all -- they supervise, they are not on the
    // hourly roster -- so for them "me" correctly fails to resolve and is
    // surfaced as a question rather than silently becoming somebody else.
    let identity
    let policyConfig: Record<string, unknown> | null = null
    try {
      identity = await getBedrockOperatorIdentity(ctx.workspaceId, ctx.operatorId)
      policyConfig = await getBedrockPolicyConfig(ctx.workspaceId)
    } catch {
      identity = { profileId: null, workerId: null }
    }

    // Defaults are measured from this business's own history, but they are
    // still assumptions until someone confirms them — so they are applied AND
    // reported, and the owner can change any of them with set_construction_policy.
    const policy = resolveCrewDayPolicy(policyConfig)
    const assumed = unconfirmed(policy)

    // "me" is only a timesheet line if this business says supervisors are on
    // the roster. Otherwise the reporter is the reporter, not a row.
    const callerWorkerId = policy.reporterLogsOwnTime.value ? identity.workerId : null

    const draft = buildCrewDayDraft({
      projectId: project.id,
      date,
      names: args.workers,
      shift: {
        start: args.start,
        end: args.end,
        breakMinutes: args.break_minutes ?? policy.breakMinutes.value,
      },
      exceptions: args.exceptions?.map((e) => ({ name: e.worker, start: e.start, end: e.end })),
      roster,
      callerId: callerWorkerId ?? undefined,
    })

    if (draft.status === 'needs_review') {
      return {
        ok: true,
        data: {
          status: 'needs_review',
          reason: 'unresolved_people_or_times',
          job: { id: project.id, name: project.name },
          date,
          issues: draft.issues,
          note: 'Ask about each item below. Do not guess a worker — a wrong match puts hours on the wrong person.',
        },
      }
    }

    let alreadyLogged: string[] = []
    try {
      const sameDay = await adapter.listProjectTimeEntryKeys(ctx.workspaceId, project.id, date)
      alreadyLogged = findDuplicates(draft.drafts, sameDay).map((d) => d.workerName)
    } catch {
      alreadyLogged = []
    }

    const question = nextCrewDayQuestion(policy, {
      reporterNamed: args.workers.some((n) => n.trim().toLowerCase() === 'me'),
      breakStated: args.break_minutes !== undefined,
      longestShiftHours: draft.drafts.reduce((max, d) => Math.max(max, d.regularHours), 0),
    })

    return {
      ok: true,
      data: {
        status: alreadyLogged.length ? 'needs_review' : 'ready',
        job: { id: project.id, name: project.name },
        date,
        entries: draft.drafts.map((d) => ({
          worker_id: d.workerId,
          worker_name: d.workerName,
          start: d.start,
          end: d.end,
          regular_hours: d.regularHours,
          break_minutes: d.breakMinutes,
        })),
        total_hours: draft.drafts.reduce((sum, d) => sum + d.regularHours, 0),
        already_logged: alreadyLogged,
        // Surfaced so the confirmation names them. A default nobody sees is a
        // default nobody agreed to.
        overtime_hours: 0,
        assumptions: {
          break_minutes: policy.breakMinutes.value,
          break_minutes_source: policy.breakMinutes.source,
          overtime_enabled: policy.overtimeEnabled.value,
          reporter_logs_own_time: policy.reporterLogsOwnTime.value,
          still_assumed: assumed,
        },
        // At most one question, and only when the assumption actually shaped
        // this day. Whether to ask is a correctness decision, so it is decided
        // here rather than left to the model to remember.
        ask: question,
        note: question
          ? `${question.question} Then read the day back and call log_crew_day.`
          : alreadyLogged.length
          ? `${alreadyLogged.join(', ')} already have time on this job for ${date}. Say so and do not log the day again.`
          : `Read this back with each person and their hours. Say the ${policy.breakMinutes.value}-minute break and the zero overtime out loud` +
            (assumed.length
              ? ' and note they are assumptions — if any is wrong, use set_construction_policy before logging.'
              : '.') +
            ' Then call log_crew_day with these exact entries.',
      },
    }
  },
}
