import 'server-only'
import {
  createBedrockAdapter,
  BedrockConnectionMissingError,
  BedrockNotFoundError,
  type BedrockAdapter,
  type BedrockEstimate,
  type BedrockPurchaseOrder,
  type BedrockReceipt,
} from '@/lib/domain-adapters/bedrock'
import type { Tool } from '../types'
import { resolveJob, bedrockConnectionErrorResult, type JobSearchAdapter } from './find-job'

export interface GetJobInput {
  id?: string
  name?: string
  include_completed?: boolean
}

/** Adapter surface get_job needs: name-resolution plus every child fetch. */
export type JobDetailAdapter = JobSearchAdapter &
  Pick<
    BedrockAdapter,
    'getProject' | 'getProjectLabor' | 'listProjectEstimates' | 'listProjectPurchaseOrders' | 'listProjectReceipts' | 'getClient'
  >

/** One child section: either its summarized data, or why it's missing — the project detail is never withheld for one child's failure. */
type Section<T> = ({ available: true } & T) | { available: false; error: string }

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await promise }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Lookup failed.' }
  }
}

const recentEstimates = (rows: BedrockEstimate[]) =>
  rows.slice(0, 3).map((e) => ({ id: e.id, number: e.number, status: e.status, total_amount: e.totalAmount, issue_date: e.issueDate }))

const recentPurchaseOrders = (rows: BedrockPurchaseOrder[]) =>
  rows.slice(0, 3).map((po) => ({ id: po.id, number: po.number, status: po.status, total_amount: po.totalAmount, order_date: po.orderDate }))

const recentReceipts = (rows: BedrockReceipt[]) =>
  rows.slice(0, 3).map((r) => ({ id: r.id, vendor_name: r.vendorNameSnapshot, total_amount: r.totalAmount, receipt_date: r.receiptDate, status: r.status }))

export function makeGetJob(adapterFactory: () => JobDetailAdapter = createBedrockAdapter): Tool<GetJobInput> {
  return {
    name: 'get_job',
    description:
      'Full state of one ODS TropiTrack project: identity, status, client, location, contract value, budget, ' +
      'labor totals, and summarized estimates/purchase orders/receipts. Pass `id` when you already have one ' +
      '(normally from find_job). Otherwise pass `name` — the exact same informal-language resolution find_job ' +
      'uses ("Blue Sky", "the Mann job", "Christiansen") — and this tool resolves it internally rather than ' +
      'you guessing an id.\n\n' +
      "READ `match` FIRST when you passed `name`. 'one' -> `job` holds the full detail. 'many' -> `candidates` " +
      "holds several projects and NOTHING was fetched — the name did not resolve to a single job; list the " +
      "candidates and ask which one, never guess. 'none' -> nothing matched that name. Never call this with a " +
      'guessed or remembered id you are not sure of — wrong-project attribution silently corrupts job costing, ' +
      'the one thing this system exists to make trustworthy; resolve with find_job first if in doubt.\n\n' +
      'Child collections (estimates, purchase orders, receipts) are summarized — counts, totals, and the ' +
      'few most recent — not dumped row by row; this is a WhatsApp reply, not a ledger export. Each child ' +
      'section degrades independently to `available: false` with its own error if its own fetch fails, without ' +
      'failing the rest of the job detail.',
    risk: 'read',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project id, normally from a prior find_job call.' },
        name: {
          type: 'string',
          description: 'Informal project/client/location name, when you do not have an id yet. Resolved the same way find_job resolves it.',
        },
        include_completed: {
          type: 'boolean',
          description: 'Only used together with `name`. Default false (active/planning projects only).',
        },
      },
    },

    async execute(args, ctx) {
      const name = args.name?.trim()
      let projectId = args.id?.trim()
      if (!projectId && !name) return { ok: false, error: 'Provide either id (from find_job) or name to look up a job.' }

      try {
        const adapter = adapterFactory()

        if (!projectId) {
          const resolution = await resolveJob(adapter, ctx.workspaceId, name as string, args.include_completed === true)
          if (resolution.match !== 'one') {
            return { ok: true, data: { query: name, ...resolution } }
          }
          projectId = resolution.candidates[0].id
        }

        const project = await adapter.getProject(ctx.workspaceId, projectId)

        const [laborResult, estimatesResult, posResult, receiptsResult, clientResult] = await Promise.all([
          settle(adapter.getProjectLabor(ctx.workspaceId, project.id)),
          settle(adapter.listProjectEstimates(ctx.workspaceId, project.id)),
          settle(adapter.listProjectPurchaseOrders(ctx.workspaceId, project.id)),
          settle(adapter.listProjectReceipts(ctx.workspaceId, project.id)),
          project.clientId
            ? settle(adapter.getClient(ctx.workspaceId, project.clientId))
            : Promise.resolve({ ok: true as const, value: null }),
        ])

        const labor: Section<{ total_hours: number; regular_hours: number; overtime_hours: number; entry_count: number; worker_count: number }> =
          laborResult.ok
            ? {
                available: true,
                total_hours: laborResult.value.totalHours,
                regular_hours: laborResult.value.regularHours,
                overtime_hours: laborResult.value.overtimeHours,
                entry_count: laborResult.value.entryCount,
                worker_count: laborResult.value.workers.length,
              }
            : { available: false, error: laborResult.error }

        const estimates: Section<{ count: number; total_amount: number; recent: ReturnType<typeof recentEstimates> }> = estimatesResult.ok
          ? { available: true, count: estimatesResult.value.length, total_amount: estimatesResult.value.reduce((s, e) => s + e.totalAmount, 0), recent: recentEstimates(estimatesResult.value) }
          : { available: false, error: estimatesResult.error }

        const purchaseOrders: Section<{ count: number; total_amount: number; recent: ReturnType<typeof recentPurchaseOrders> }> = posResult.ok
          ? { available: true, count: posResult.value.length, total_amount: posResult.value.reduce((s, po) => s + po.totalAmount, 0), recent: recentPurchaseOrders(posResult.value) }
          : { available: false, error: posResult.error }

        const receipts: Section<{ count: number; total_amount: number; recent: ReturnType<typeof recentReceipts> }> = receiptsResult.ok
          ? { available: true, count: receiptsResult.value.length, total_amount: receiptsResult.value.reduce((s, r) => s + r.totalAmount, 0), recent: recentReceipts(receiptsResult.value) }
          : { available: false, error: receiptsResult.error }

        const client: Section<{ id: string | null; name: string | null; email: string | null; phone: string | null }> = clientResult.ok
          ? clientResult.value
            ? { available: true, id: clientResult.value.id, name: clientResult.value.name, email: clientResult.value.email, phone: clientResult.value.phone }
            : { available: true, id: null, name: project.clientNameSnapshot, email: null, phone: null }
          : { available: false, error: clientResult.error }

        return {
          ok: true,
          data: {
            match: 'one',
            job: {
              id: project.id,
              name: project.name,
              status: project.status,
              location: project.location,
              contract_value: project.contractValue,
              budget: project.budget,
              start_date: project.startDate,
              estimated_end_date: project.estimatedEndDate,
              client,
              labor,
              estimates,
              purchase_orders: purchaseOrders,
              receipts,
            },
          },
        }
      } catch (err) {
        if (err instanceof BedrockConnectionMissingError) return bedrockConnectionErrorResult()
        if (err instanceof BedrockNotFoundError) return { ok: false, error: `No job found with id "${projectId}" in this workspace.` }
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to load job.' }
      }
    },
  }
}

export const getJob: Tool<GetJobInput> = makeGetJob()
