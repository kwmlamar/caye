import 'server-only'

import {
  createBedrockAdapter,
  createBedrockWriteProvider,
  BedrockConnectionMissingError,
  type BedrockTimeEntryInsert,
} from '@/lib/domain-adapters/bedrock'
import { findDuplicates, type CrewDayDraftRow } from '@/lib/ods/crew-day'
import type { Tool } from '../types'

/**
 * Write one crew day's timesheet rows into the construction ledger.
 *
 * THE FIRST WRITE
 *
 * Everything else Caye does against Bedrock/TropiTrack is read-only by
 * construction. This is the one path that changes the source system, and it
 * changes the table that feeds payroll — so it is `high` risk, staged through
 * the pending-action gate like every other consequential write, and verified
 * afterwards rather than assumed.
 *
 * WHY THIS TOOL TAKES IDS AND NOT NAMES
 *
 * `preview_crew_day` does the resolving. By the time anything is staged for
 * confirmation, the worker ids, project id and hours are already fixed. If this
 * tool took "Cyril" and resolved it at execution time, the thing the operator
 * confirmed and the thing that got written would be two different objects, and
 * a roster change between the two would silently move hours onto another
 * person. What is confirmed is what is written.
 */

export interface LogCrewDayEntry {
  worker_id: string
  worker_name: string
  start: string
  end: string
  regular_hours: number
  break_minutes: number
}

export interface LogCrewDayInput {
  project_id: string
  date: string
  entries: LogCrewDayEntry[]
  notes?: string
}

const HOURS_CEILING = 24

export const logCrewDay: Tool<LogCrewDayInput> = {
  name: 'log_crew_day',
  description:
    "Write a day's timesheet rows into the construction ledger for a crew. " +
    'Call preview_crew_day FIRST and use the exact project_id, date and entries it returns — ' +
    'never assemble the entries yourself from names, and never re-type an id from memory. ' +
    'This writes to the system that feeds payroll, so it is staged for explicit confirmation ' +
    'before anything is written. Overtime is always zero: no overtime policy is recorded for ' +
    'this business, so a long day is corrected in the app rather than guessed here.',
  risk: 'high',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'The project id exactly as returned by preview_crew_day.',
      },
      date: {
        type: 'string',
        description: 'The work date, YYYY-MM-DD, exactly as returned by preview_crew_day.',
      },
      entries: {
        type: 'array',
        description: 'The resolved rows from preview_crew_day, unmodified.',
        items: {
          type: 'object',
          properties: {
            worker_id: { type: 'string', description: 'Resolved worker id.' },
            worker_name: { type: 'string', description: 'Worker name, for the confirmation summary.' },
            start: { type: 'string', description: 'Start time, HH:MM.' },
            end: { type: 'string', description: 'End time, HH:MM.' },
            regular_hours: { type: 'number', description: 'Hours worked, break already deducted.' },
            break_minutes: { type: 'number', description: 'Unpaid break in minutes.' },
          },
          required: ['worker_id', 'worker_name', 'start', 'end', 'regular_hours', 'break_minutes'],
        },
      },
      notes: {
        type: 'string',
        description: 'Optional short note stored on every row of this day.',
      },
    },
    required: ['project_id', 'date', 'entries'],
  },

  async execute(args, ctx) {
    if (!args.entries?.length) {
      return { ok: false, error: 'No entries to log. Run preview_crew_day first.' }
    }

    for (const entry of args.entries) {
      if (!Number.isFinite(entry.regular_hours) || entry.regular_hours <= 0 || entry.regular_hours > HOURS_CEILING) {
        return {
          ok: false,
          error: `Refusing to write ${entry.regular_hours} hours for ${entry.worker_name}. Re-run preview_crew_day.`,
        }
      }
    }

    let write: Awaited<ReturnType<typeof createBedrockWriteProvider>>
    try {
      write = await createBedrockWriteProvider(ctx.workspaceId)
    } catch (error) {
      if (error instanceof BedrockConnectionMissingError) {
        return { ok: false, error: 'This workspace is not connected to a construction ledger.' }
      }
      return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the ledger.' }
    }

    // A timesheet row must say which real person recorded it. There is no
    // default author and inventing one would put someone else's name on a
    // payroll record, so an unmapped operator is a refusal, not a fallback.
    const createdBy = write.identityFor(ctx.operatorId).profileId
    if (!createdBy) {
      return {
        ok: false,
        error:
          'No ledger identity is mapped for you, so this day cannot be attributed to a real person. ' +
          'Ask Lamar to add your profile mapping to the workspace ledger connection before logging time.',
      }
    }

    const adapter = createBedrockAdapter()

    // Re-checked here and not only in the preview. State can move between the
    // moment a day is staged and the moment it is confirmed, and a duplicate
    // written twice doubles what somebody is paid.
    let existing: Array<{ workerId: string; projectId: string; date: string }> = []
    try {
      existing = await adapter.listProjectTimeEntryKeys(ctx.workspaceId, args.project_id, args.date)
    } catch {
      return {
        ok: false,
        error: 'Could not check for existing entries on that day, so nothing was written. Try again.',
      }
    }

    const drafts: CrewDayDraftRow[] = args.entries.map((entry) => ({
      workerId: entry.worker_id,
      workerName: entry.worker_name,
      projectId: args.project_id,
      date: args.date,
      start: entry.start,
      end: entry.end,
      regularHours: entry.regular_hours,
      overtimeHours: 0,
      breakMinutes: entry.break_minutes,
    }))

    const duplicates = findDuplicates(drafts, existing)
    if (duplicates.length) {
      return {
        ok: false,
        error:
          `${duplicates.length} of these workers already have time logged on this job for ${args.date}: ` +
          `${duplicates.map((d) => d.workerName).join(', ')}. Nothing was written. ` +
          'Correct the existing entries in the app rather than adding a second set.',
      }
    }

    const rows: BedrockTimeEntryInsert[] = drafts.map((draft) => ({
      worker_id: draft.workerId,
      project_id: draft.projectId,
      date: draft.date,
      start_time: draft.start,
      end_time: draft.end,
      break_duration_minutes: draft.breakMinutes,
      regular_hours: draft.regularHours,
      // Never computed. See the tool description and the design brief.
      overtime_hours: 0,
      notes: args.notes?.trim() || null,
      created_by: createdBy,
      company_id: write.companyId,
    }))

    const result = await write.provider.insertTimeEntries(write.companyId, rows)

    // A provider receipt is evidence of execution, not of effect. Re-read the
    // day from the ledger and report what is actually there.
    let verifiedCount: number | null = null
    try {
      const after = await adapter.listProjectTimeEntryKeys(ctx.workspaceId, args.project_id, args.date)
      const workerIds = new Set(drafts.map((d) => d.workerId))
      verifiedCount = after.filter((key) => workerIds.has(key.workerId)).length
    } catch {
      verifiedCount = null
    }

    return {
      ok: result.ok && verifiedCount === drafts.length,
      data: {
        project_id: args.project_id,
        date: args.date,
        attempted: result.attemptedCount,
        written: result.insertedCount,
        verified_present: verifiedCount,
        failed: result.failedRows.map((failure) => ({
          worker_name: drafts[failure.index]?.workerName ?? 'unknown',
          error: failure.error,
        })),
        audit_recorded: result.auditLogWritten,
        audit_error: result.auditLogError,
        note:
          verifiedCount === null
            ? 'Rows were written but could not be re-read to confirm. Check the app before logging this day again.'
            : verifiedCount === drafts.length
              ? `Verified ${verifiedCount} entries present in the ledger.`
              : `Only ${verifiedCount} of ${drafts.length} entries could be confirmed present. Do not re-run without checking.`,
      },
    }
  },
}
