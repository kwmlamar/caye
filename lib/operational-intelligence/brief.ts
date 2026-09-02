import 'server-only'

import type {
  BedrockHealth,
  BedrockProject,
  BedrockProjectLabor,
  BedrockPurchaseOrder,
  BedrockEstimate,
  BedrockReceipt,
  BedrockVendor,
} from '@/lib/domain-adapters/bedrock/types'

export type EpistemicKind = 'fact' | 'inference' | 'unknown'

export interface OperationalProvenance {
  sourceSystem: string
  authority: string
  sourceEntityType?: string
  sourceEntityId?: string
  workspaceId: string
  companyId?: string
  observedAt: string
}

export interface OperationalClaim {
  kind: EpistemicKind
  text: string
  stale: boolean
  provenance: OperationalProvenance[]
}

export interface OperationalSection {
  key: 'active_jobs' | 'materials_procurement' | 'labor' | 'estimates' | 'attention' | 'unknown'
  title: string
  claims: OperationalClaim[]
}

export interface OperationalBrief {
  workspaceId: string
  generatedAt: string
  sections: OperationalSection[]
}

export interface CayeAttentionEvent {
  id: number
  type: string
  occurredAt: string
  observedAt: string
  isFailure: boolean
  sourceSystem: string | null
  sourceEntityType: string | null
  sourceEntityId: string | null
  summary: string
}

export interface UnresolvedDomainMapping {
  sourceSystem: string
  sourceCompanyId: string
  sourceEntityType: string
  sourceEntityId: string
  lastObservedAt: string
}

export interface DomainSyncState {
  sourceSystem: string
  sourceCompanyId: string
  stream: string
  updatedAt: string
  watermark: string | null
}

export interface DomainConnectionState {
  sourceSystem: string
  externalTenantId: string
  status: string
  updatedAt: string
}

export interface CayeOperationalState {
  connection: DomainConnectionState | null
  attentionEvents: CayeAttentionEvent[]
  unresolvedMappings: UnresolvedDomainMapping[]
  syncStates: DomainSyncState[]
}

export interface OperationalSource {
  health(workspaceId: string): Promise<BedrockHealth>
  listProjects(workspaceId: string, options?: { status?: string; limit?: number }): Promise<BedrockProject[]>
  getProjectLabor(workspaceId: string, projectId: string): Promise<BedrockProjectLabor>
  listProjectPurchaseOrders(workspaceId: string, projectId: string): Promise<BedrockPurchaseOrder[]>
  getVendor(workspaceId: string, vendorId: string): Promise<BedrockVendor>
  listProjectReceipts(workspaceId: string, projectId: string): Promise<BedrockReceipt[]>
  listProjectEstimates(workspaceId: string, projectId: string): Promise<BedrockEstimate[]>
}

export interface CayeOperationalStateReader {
  read(workspaceId: string): Promise<CayeOperationalState>
}

const OPEN_PO = new Set(['draft', 'submitted', 'approved', 'ordered', 'partial_received'])
const STALE_SYNC_MS = 6 * 60 * 60 * 1000

function provenance(
  item: {
    sourceSystem: string
    authority: string
    sourceEntityType: string
    sourceEntityId: string
    workspaceId: string
    companyId: string
  },
  observedAt: string,
): OperationalProvenance {
  return {
    sourceSystem: item.sourceSystem,
    authority: item.authority,
    sourceEntityType: item.sourceEntityType,
    sourceEntityId: item.sourceEntityId,
    workspaceId: item.workspaceId,
    companyId: item.companyId,
    observedAt,
  }
}

function cayeProvenance(workspaceId: string, observedAt: string, entityType?: string, entityId?: string): OperationalProvenance {
  return {
    sourceSystem: 'caye',
    authority: 'caye_event_state',
    sourceEntityType: entityType,
    sourceEntityId: entityId,
    workspaceId,
    observedAt,
  }
}

function assertWorkspace(workspaceId: string, item: { workspaceId: string; sourceEntityType?: string; sourceEntityId?: string }) {
  if (item.workspaceId !== workspaceId) {
    throw new Error(`Cross-workspace operational source result rejected for ${item.sourceEntityType ?? 'entity'}:${item.sourceEntityId ?? 'unknown'}`)
  }
}

function fact(text: string, provenance: OperationalProvenance[], stale = false): OperationalClaim {
  return { kind: 'fact', text, stale, provenance }
}

function inference(text: string, provenance: OperationalProvenance[], stale = false): OperationalClaim {
  return { kind: 'inference', text, stale, provenance }
}

function unknown(text: string, workspaceId: string, observedAt: string): OperationalClaim {
  return { kind: 'unknown', text, stale: false, provenance: [cayeProvenance(workspaceId, observedAt)] }
}

export async function buildOperationalBrief(args: {
  workspaceId: string
  source: OperationalSource
  caye: CayeOperationalStateReader
  now?: Date
}): Promise<OperationalBrief> {
  const generatedAt = (args.now ?? new Date()).toISOString()
  const { workspaceId, source } = args
  const [health, cayeState] = await Promise.all([
    source.health(workspaceId),
    args.caye.read(workspaceId),
  ])
  assertWorkspace(workspaceId, health)

  const jobs: OperationalClaim[] = []
  const procurement: OperationalClaim[] = []
  const labor: OperationalClaim[] = []
  const estimates: OperationalClaim[] = []
  const attention: OperationalClaim[] = []

  if (!health.ok) {
    attention.push(fact(
      'Bedrock health check did not confirm the configured company, so live construction state is unavailable.',
      [provenance(health, generatedAt)],
    ))
  } else {
    const projects = await source.listProjects(workspaceId, { status: 'active', limit: 100 })
    for (const project of projects) assertWorkspace(workspaceId, project)

    if (projects.length === 0) {
      jobs.push(fact(
        'The authoritative Bedrock active-project query returned zero rows. This only establishes that no rows matched status=active at read time.',
        [provenance(health, generatedAt)],
      ))
    }

    for (const project of projects) {
      const projectProv = [provenance(project, generatedAt)]
      jobs.push(fact(
        `${project.name || 'Unnamed project'} is active${project.location ? ` at ${project.location}` : ''}.`,
        projectProv,
      ))
      if (!project.status) {
        jobs.push(fact(`${project.name || 'Unnamed project'} has no project status value in the authoritative read.`, projectProv))
      }

      const [projectLabor, pos, receipts, projectEstimates] = await Promise.all([
        source.getProjectLabor(workspaceId, project.id),
        source.listProjectPurchaseOrders(workspaceId, project.id),
        source.listProjectReceipts(workspaceId, project.id),
        source.listProjectEstimates(workspaceId, project.id),
      ])
      assertWorkspace(workspaceId, projectLabor)
      for (const row of [...pos, ...receipts, ...projectEstimates]) assertWorkspace(workspaceId, row)

      labor.push(fact(
        `${project.name || 'Unnamed project'} has ${projectLabor.entryCount} labor entries totaling ${projectLabor.totalHours} hours in the currently supported project-labor read.`,
        [provenance(projectLabor, generatedAt)],
      ))
      if (projectLabor.entryCount === 0) {
        labor.push(inference(
          `${project.name || 'Unnamed project'} has no labor entries in the returned project-labor dataset; this may indicate missing or not-yet-entered time and is not proof that nobody is working.`,
          [provenance(projectLabor, generatedAt)],
        ))
      }

      for (const po of pos) {
        let vendor: BedrockVendor | null = null
        if (po.vendorId) {
          vendor = await source.getVendor(workspaceId, po.vendorId)
          assertWorkspace(workspaceId, vendor)
        }
        const refs = [provenance(po, generatedAt), ...(vendor ? [provenance(vendor, generatedAt)] : [])]
        procurement.push(fact(
          `PO ${po.number ?? po.id} for ${project.name || 'Unnamed project'} is ${po.status ?? 'status unknown'}${vendor?.name ? ` with ${vendor.name}` : ''}.`,
          refs,
        ))
        if (po.status && OPEN_PO.has(po.status)) {
          procurement.push(inference(
            `PO ${po.number ?? po.id} appears unresolved because its authoritative status is ${po.status}; no claim is made about payment or delivery beyond that status.`,
            refs,
          ))
        }
      }

      for (const receipt of receipts) {
        procurement.push(fact(
          `Receipt ${receipt.id} for ${project.name || 'Unnamed project'} is ${receipt.status ?? 'status unknown'}${receipt.vendorNameSnapshot ? ` and names ${receipt.vendorNameSnapshot}` : ''}.`,
          [provenance(receipt, generatedAt)],
        ))
      }

      for (const estimate of projectEstimates) {
        estimates.push(fact(
          `Estimate ${estimate.number ?? estimate.id} for ${project.name || 'Unnamed project'} is ${estimate.status ?? 'status unknown'}.`,
          [provenance(estimate, generatedAt)],
        ))
      }
    }
  }

  if (!cayeState.connection) {
    attention.push(fact(
      'Caye has no Bedrock domain-source connection row for this workspace.',
      [cayeProvenance(workspaceId, generatedAt, 'domain_source_connection')],
    ))
  } else if (cayeState.connection.status !== 'active') {
    attention.push(fact(
      `The Bedrock domain-source connection is ${cayeState.connection.status}.`,
      [cayeProvenance(workspaceId, cayeState.connection.updatedAt, 'domain_source_connection', cayeState.connection.externalTenantId)],
    ))
  }

  for (const mapping of cayeState.unresolvedMappings) {
    attention.push(fact(
      `Canonical mapping is unresolved for ${mapping.sourceSystem}/${mapping.sourceEntityType}/${mapping.sourceEntityId}.`,
      [cayeProvenance(workspaceId, mapping.lastObservedAt, mapping.sourceEntityType, mapping.sourceEntityId)],
    ))
  }

  for (const sync of cayeState.syncStates) {
    const age = Date.parse(generatedAt) - Date.parse(sync.updatedAt)
    if (Number.isFinite(age) && age > STALE_SYNC_MS) {
      attention.push(inference(
        `${sync.sourceSystem}/${sync.stream} synchronization state has not advanced for more than 6 hours; treat event-derived state as stale until the sync path is verified.`,
        [cayeProvenance(workspaceId, sync.updatedAt, 'domain_sync_cursor', sync.stream)],
        true,
      ))
    }
  }

  for (const event of cayeState.attentionEvents) {
    attention.push(fact(
      event.summary,
      [cayeProvenance(workspaceId, event.observedAt, event.sourceEntityType ?? 'workspace_event', event.sourceEntityId ?? String(event.id))],
      false,
    ))
  }

  const unknowns: OperationalClaim[] = [
    unknown('Confirmed accounts-receivable and payment state is not established by V1. Bedrock invoices/payments are not part of the currently supported aggregate read surface.', workspaceId, generatedAt),
    unknown('Current payroll cannot be identified deterministically because the adapter can summarize a known pay-period ID but does not yet expose pay-period discovery.', workspaceId, generatedAt),
    unknown('WhatsApp or other field coordination outside connected Caye channels is not visible here.', workspaceId, generatedAt),
    unknown('Bank settlement state is not connected.', workspaceId, generatedAt),
    unknown('Freight or shipment details that live outside connected Bedrock/Caye sources are not connected.', workspaceId, generatedAt),
  ]

  return {
    workspaceId,
    generatedAt,
    sections: [
      { key: 'active_jobs', title: 'ACTIVE JOBS', claims: jobs },
      { key: 'materials_procurement', title: 'MATERIALS / PROCUREMENT', claims: procurement },
      { key: 'labor', title: 'LABOR', claims: labor },
      { key: 'estimates', title: 'ESTIMATES', claims: estimates },
      { key: 'attention', title: 'ATTENTION', claims: attention },
      { key: 'unknown', title: 'UNKNOWN / NOT YET CONNECTED', claims: unknowns },
    ],
  }
}

export function renderOperationalBrief(brief: OperationalBrief): string {
  return brief.sections.map(section => {
    const lines = section.claims.length > 0
      ? section.claims.map(claim => {
          const tag = claim.kind.toUpperCase()
          const freshness = claim.stale ? ' | STALE' : ''
          const source = claim.provenance.map(p => `${p.sourceSystem}:${p.sourceEntityType ?? 'state'}:${p.sourceEntityId ?? 'n/a'}@${p.observedAt}`).join(', ')
          return `- [${tag}${freshness}] ${claim.text} [source: ${source}]`
        })
      : ['- [UNKNOWN] No supported source returned a statement for this section. This is not equivalent to none.']
    return `${section.title}\n${lines.join('\n')}`
  }).join('\n\n')
}
