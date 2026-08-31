import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import type {
  ResearchDeskCheckpoint,
  ResearchDeskCycle,
  ResearchDeskDefinition,
  ResearchDeskScheduler,
  ResearchDeskStore,
} from './runtime'

type DeskRow = Record<string, any>
type CycleRow = Record<string, any>

function toDesk(row: DeskRow): ResearchDeskDefinition {
  return {
    id: row.id,
    key: row.desk_key,
    programId: row.program_id,
    workspaceId: row.workspace_id,
    domain: row.domain,
    standingMission: row.standing_mission,
    standingQuestions: row.standing_questions ?? [],
    cadence: row.cadence,
    explorationBudget: row.exploration_budget,
    sourcePreferences: row.source_preferences ?? [],
    geographicScope: row.geographic_scope ?? [],
    languageScope: row.language_scope ?? [],
    currentHypotheses: row.current_hypotheses ?? [],
    lastSuccessfulResearch: row.last_successful_research,
    nextScheduledInvestigation: row.next_scheduled_investigation,
    confidenceThreshold: Number(row.confidence_threshold),
    relevanceThreshold: Number(row.relevance_threshold),
    escalationPolicy: row.escalation_policy ?? {},
    status: row.status,
  }
}

function normalizeCheckpoint(value: unknown): ResearchDeskCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const checkpoint = value as Partial<ResearchDeskCheckpoint>
  if (!Array.isArray(checkpoint.processedQuestionKeys) || !Array.isArray(checkpoint.pendingQuestions) || !Array.isArray(checkpoint.results) || !checkpoint.usage) return null
  return checkpoint as ResearchDeskCheckpoint
}

function toCycle(row: CycleRow): ResearchDeskCycle {
  return {
    deskId: row.desk_id,
    wakeupKey: row.wakeup_key,
    status: row.status,
    materialChange: Boolean(row.material_change),
    contradictoryEvidence: Boolean(row.contradictory_evidence),
    summary: row.summary ?? '',
    startedAt: row.started_at,
    completedAt: row.completed_at ?? row.started_at,
    nextScheduledInvestigation: row.next_scheduled_investigation ?? row.completed_at ?? row.started_at,
    usage: row.budget_usage ?? { queries: 0, sources: 0, tokens: 0, costUsd: 0, depth: 0, retries: 0 },
    investigatedQuestions: row.checkpoint?.results?.map((result: any) => result?.question?.question).filter(Boolean) ?? [],
    errors: row.checkpoint?.errors ?? [],
    fingerprint: row.fingerprint,
  }
}

export function createSupabaseResearchDeskStore(): ResearchDeskStore {
  const db = createServiceClient()
  return {
    async getDesk(deskId) {
      const result = await db.from('research_desks').select('*').eq('id', deskId).maybeSingle()
      if (result.error) throw result.error
      return result.data ? toDesk(result.data) : null
    },

    async reserveCycle({ deskId, wakeupKey, startedAt }) {
      const inserted = await db.from('research_desk_cycles').insert({
        desk_id: deskId,
        wakeup_key: wakeupKey,
        status: 'running',
        started_at: startedAt,
      }).select('*').maybeSingle()

      if (!inserted.error && inserted.data) return { reserved: true as const, checkpoint: null }
      if (inserted.error?.code !== '23505') throw inserted.error

      const existing = await db.from('research_desk_cycles').select('*').eq('desk_id', deskId).eq('wakeup_key', wakeupKey).single()
      if (existing.error) throw existing.error
      if (existing.data.status === 'running') {
        return { reserved: true as const, checkpoint: normalizeCheckpoint(existing.data.checkpoint) }
      }
      return { reserved: false as const, cycle: toCycle(existing.data) }
    },

    async saveCheckpoint({ deskId, wakeupKey, checkpoint }) {
      const result = await db.from('research_desk_cycles').update({ checkpoint }).eq('desk_id', deskId).eq('wakeup_key', wakeupKey).eq('status', 'running')
      if (result.error) throw result.error
    },

    async completeCycle(cycle) {
      const cycleUpdate = await db.from('research_desk_cycles').update({
        status: cycle.status,
        material_change: cycle.materialChange,
        contradictory_evidence: cycle.contradictoryEvidence,
        summary: cycle.summary,
        fingerprint: cycle.fingerprint ?? null,
        budget_usage: cycle.usage,
        next_scheduled_investigation: cycle.nextScheduledInvestigation,
        checkpoint: {
          results: cycle.investigatedQuestions.map((question) => ({ question: { question } })),
          errors: cycle.errors,
        },
        completed_at: cycle.completedAt,
      }).eq('desk_id', cycle.deskId).eq('wakeup_key', cycle.wakeupKey).eq('status', 'running')
      if (cycleUpdate.error) throw cycleUpdate.error

      const deskPatch: Record<string, unknown> = {
        next_scheduled_investigation: cycle.nextScheduledInvestigation,
        updated_at: cycle.completedAt,
        state: {
          lastCycleStatus: cycle.status,
          lastFingerprint: cycle.fingerprint ?? null,
          lastMaterialChange: cycle.materialChange,
          lastContradictoryEvidence: cycle.contradictoryEvidence,
          lastBudgetUsage: cycle.usage,
        },
      }
      if (cycle.status === 'completed' || cycle.status === 'unchanged') deskPatch.last_successful_research = cycle.completedAt
      const deskUpdate = await db.from('research_desks').update(deskPatch).eq('id', cycle.deskId)
      if (deskUpdate.error) throw deskUpdate.error
    },

    async recordNoChange({ deskId, wakeupKey, at, fingerprint, summary }) {
      const result = await db.from('research_desk_cycles').update({
        summary,
        fingerprint: fingerprint ?? null,
        checkpoint: { noChange: true, recordedAt: at },
      }).eq('desk_id', deskId).eq('wakeup_key', wakeupKey).eq('status', 'running')
      if (result.error) throw result.error
    },
  }
}

export function createSupabaseResearchDeskScheduler(): ResearchDeskScheduler {
  const db = createServiceClient()
  return {
    async schedule({ desk, at, reason }) {
      const result = await db.from('research_desks').update({
        next_scheduled_investigation: at,
        updated_at: new Date().toISOString(),
        state: { lastScheduleReason: reason },
      }).eq('id', desk.id).eq('status', 'active')
      if (result.error) throw result.error
    },
  }
}

export async function claimDueResearchDesk(workerId: string, at = new Date().toISOString()): Promise<{ deskId: string; wakeupKey: string } | null> {
  if (!workerId.trim()) throw new Error('workerId is required')
  const db = createServiceClient()
  const result = await db.rpc('claim_due_research_desk', { p_worker: workerId.trim(), p_now: at })
  if (result.error) throw result.error
  const row = result.data?.[0]
  return row ? { deskId: row.desk_id, wakeupKey: row.wakeup_key } : null
}
