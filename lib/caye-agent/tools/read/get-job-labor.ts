import 'server-only'
import {
  createBedrockAdapter,
  BedrockConnectionMissingError,
  BedrockNotFoundError,
  type BedrockAdapter,
} from '@/lib/domain-adapters/bedrock'
import type { Tool } from '../types'

export interface GetJobLaborInput {
  /** TropiTrack project id, when already known (e.g. from get_job). */
  project_id?: string
  /** Informal/partial project name to resolve, e.g. "Capricorn pool" or "Blue Sky". */
  project_name?: string
  /** Optional YYYY-MM-DD range start. See tool description — not currently applied server-side. */
  start_date?: string
  /** Optional YYYY-MM-DD range end. See tool description — not currently applied server-side. */
  end_date?: string
}

/**
 * The subset of BedrockAdapter this tool actually calls — narrowed so tests
 * can inject a fake without shaping every other adapter method.
 */
type LaborAdapter = Pick<BedrockAdapter, 'findProjects' | 'getProjectLabor' | 'getWorker'>

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Factory seam: production callers get the real, kernel-bound Bedrock
 * adapter; tests pass a fake implementing only findProjects/getProjectLabor/
 * getWorker (see get-job-labor.test.ts).
 */
export function makeGetJobLabor(
  getAdapter: () => LaborAdapter = createBedrockAdapter
): Tool<GetJobLaborInput> {
  return {
    name: 'get_job_labor',
    description:
      'How many hours (and, when TropiTrack has worker rates, roughly how much labour cost) have gone into a TropiTrack construction project. ' +
      'Pass project_id when it is already known, otherwise pass project_name and it resolves via TropiTrack search — an informal name like "Capricorn pool" or "the Mann job" is fine. ' +
      "If the name matches more than one project, the result comes back with resolution: 'ambiguous' and a list of candidates instead of a guess — ASK which project before recording or quoting anything, because a wrong match silently corrupts job costing. " +
      'Returns total regular/overtime/total hours, the entry count, and a per-worker breakdown. ' +
      'start_date/end_date are accepted but the TropiTrack read adapter does NOT currently support server-side date-range filtering — when either is supplied, the figures returned are still ALL-TIME totals for the project, and `date_range.applied` is explicitly false with a note saying so. Never present these numbers as scoped to the requested range; say plainly that they are all-time. ' +
      'Per-worker `labor_cost` (hours x hourly_rate) is included only when TropiTrack has an hourly_rate on file for that worker; `rates_available` is false and `total_labor_cost` is null whenever any worker in the breakdown is missing a rate. This cost figure does not account for overtime premiums or other pay adjustments — treat it as an estimate, not a payroll figure. ' +
      'Never exposes worker NIB numbers or other sensitive worker identifiers — this tool only ever returns worker id, name, hours, and (when available) hourly rate.',
    risk: 'read',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'TropiTrack project id, when already known.',
        },
        project_name: {
          type: 'string',
          description:
            'Informal or partial project name to resolve via TropiTrack search, used when project_id is not known.',
        },
        start_date: {
          type: 'string',
          description:
            'Optional YYYY-MM-DD range start. NOTE: not currently applied — the TropiTrack adapter has no date-range filtering, so supplying this still returns all-time figures with an explicit unapplied-range note.',
        },
        end_date: {
          type: 'string',
          description: 'Optional YYYY-MM-DD range end. See start_date note.',
        },
      },
    },

    async execute(args, ctx) {
      const projectIdInput = args.project_id?.trim()
      const projectNameInput = args.project_name?.trim()
      if (!projectIdInput && !projectNameInput) {
        return {
          ok: false,
          status: 'FAILED_PERMANENT',
          error: 'Provide either project_id or project_name.',
        }
      }
      if (args.start_date && !ISO_DATE.test(args.start_date)) {
        return { ok: false, status: 'FAILED_PERMANENT', error: 'start_date must be YYYY-MM-DD.' }
      }
      if (args.end_date && !ISO_DATE.test(args.end_date)) {
        return { ok: false, status: 'FAILED_PERMANENT', error: 'end_date must be YYYY-MM-DD.' }
      }
      if (args.start_date && args.end_date && args.end_date < args.start_date) {
        return {
          ok: false,
          status: 'FAILED_PERMANENT',
          error: 'end_date cannot be before start_date.',
        }
      }

      const adapter = getAdapter()
      let resolvedId = projectIdInput
      let resolvedName: string | null = null

      try {
        if (!resolvedId) {
          const matches = await adapter.findProjects(ctx.workspaceId, projectNameInput!, 6)
          if (matches.length === 0) {
            return {
              ok: false,
              status: 'NOT_FOUND',
              error: `No TropiTrack project matches "${projectNameInput}".`,
            }
          }
          if (matches.length > 1) {
            return {
              ok: true,
              data: {
                resolution: 'ambiguous',
                query: projectNameInput,
                candidates: matches.map((p) => ({
                  id: p.id,
                  name: p.name,
                  status: p.status,
                  client: p.clientNameSnapshot,
                  location: p.location,
                })),
                note: 'Multiple TropiTrack projects match this name. Ask which one before recording or quoting hours against any of them — a wrong match silently corrupts job costing.',
              },
            }
          }
          resolvedId = matches[0].id
          resolvedName = matches[0].name
        }

        const labor = await adapter.getProjectLabor(ctx.workspaceId, resolvedId)

        let ratesAvailable = true
        let totalLaborCost = 0
        const workers = await Promise.all(
          labor.workers.map(async (w) => {
            let rate: number | null = null
            try {
              const worker = await adapter.getWorker(ctx.workspaceId, w.workerId)
              rate = worker.hourlyRate
            } catch {
              rate = null
            }
            if (rate == null) ratesAvailable = false
            const cost = rate != null ? round2(rate * w.totalHours) : null
            if (cost != null) totalLaborCost += cost
            return {
              worker_id: w.workerId,
              worker_name: w.workerName,
              regular_hours: w.regularHours,
              overtime_hours: w.overtimeHours,
              total_hours: w.totalHours,
              hourly_rate: rate,
              labor_cost: cost,
            }
          })
        )

        const rangeRequested = Boolean(args.start_date || args.end_date)

        return {
          ok: true,
          data: {
            project: { id: resolvedId, name: resolvedName },
            date_range: {
              requested: rangeRequested
                ? { start_date: args.start_date ?? null, end_date: args.end_date ?? null }
                : null,
              applied: false,
              note: rangeRequested
                ? 'The TropiTrack adapter does not support date-range filtering yet. The figures below are ALL-TIME totals for this project, not limited to the requested range.'
                : 'No date range was requested. Figures below are ALL-TIME totals for this project.',
            },
            regular_hours: labor.regularHours,
            overtime_hours: labor.overtimeHours,
            total_hours: labor.totalHours,
            entry_count: labor.entryCount,
            workers,
            rates_available: ratesAvailable,
            total_labor_cost: ratesAvailable ? round2(totalLaborCost) : null,
          },
        }
      } catch (err) {
        if (err instanceof BedrockConnectionMissingError) {
          return {
            ok: false,
            status: 'FAILED_PERMANENT',
            error: 'This workspace has no TropiTrack (construction ledger) connection configured.',
          }
        }
        if (err instanceof BedrockNotFoundError) {
          return {
            ok: false,
            status: 'NOT_FOUND',
            error: `No TropiTrack project found for id "${resolvedId}".`,
          }
        }
        return {
          ok: false,
          status: 'FAILED_RETRYABLE',
          error: err instanceof Error ? err.message : 'Failed to read job labor from TropiTrack.',
        }
      }
    },
  }
}

export const getJobLabor: Tool<GetJobLaborInput> = makeGetJobLabor()
