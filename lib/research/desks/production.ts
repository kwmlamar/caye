import 'server-only'

import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { ingestIntelligenceFinding, type IntelligenceFinding } from '@/lib/intelligence/ingest'
import { executeResearchRun, queueResearchRun } from '@/lib/research/runtime'
import { createResearchProviderSession } from '@/lib/research/providers/router'
import { recordResearchRoutingProvenance } from '@/lib/research/providers/provenance'
import {
  runResearchDeskCycle,
  type ExistingDeskIntelligence,
  type ResearchDeskDefinition,
  type ResearchDeskQuestion,
  type ResearchDeskResearchResult,
} from './runtime'
import {
  claimDueResearchDesk,
  createSupabaseResearchDeskScheduler,
  createSupabaseResearchDeskStore,
} from './supabase'

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function fingerprintClaims(claims: Array<{ statement: string; status?: string }>): string | null {
  if (!claims.length) return null
  return createHash('sha256')
    .update(claims.map((claim) => `${normalize(claim.statement)}|${claim.status ?? ''}`).sort().join('\n'))
    .digest('hex')
}

async function readDeskIntelligence(desk: ResearchDeskDefinition): Promise<ExistingDeskIntelligence> {
  const db = createServiceClient()
  const questionsResult = await db.from('research_questions').select('id,question').eq('program_id', desk.programId)
  if (questionsResult.error) throw questionsResult.error
  const questions = questionsResult.data ?? []
  const questionById = new Map(questions.map((row) => [row.id, row.question]))
  const questionIds = questions.map((row) => row.id)
  if (!questionIds.length) return { recentQuestions: [], currentClaims: [], latestBrief: null, fingerprint: null }

  const [runsResult, claimsResult, briefsResult] = await Promise.all([
    db.from('research_runs').select('question_id,created_at').in('question_id', questionIds).order('created_at', { ascending: false }).limit(40),
    db.from('research_claims').select('statement,confidence,status').in('question_id', questionIds).in('status', ['current', 'contested']).order('created_at', { ascending: false }).limit(200),
    db.from('research_briefs').select('question_id,material_changes,unknowns,created_at').in('question_id', questionIds).order('created_at', { ascending: false }).limit(40),
  ])
  if (runsResult.error) throw runsResult.error
  if (claimsResult.error) throw claimsResult.error
  if (briefsResult.error) throw briefsResult.error

  const recentQuestions = [...new Set((runsResult.data ?? []).map((row) => questionById.get(row.question_id)).filter((value): value is string => Boolean(value)))]
  const currentClaims = (claimsResult.data ?? []).map((row) => ({
    statement: row.statement,
    confidence: row.confidence == null ? null : Number(row.confidence),
    status: row.status,
  }))
  const latestBriefRow = briefsResult.data?.[0]

  return {
    recentQuestions,
    currentClaims,
    latestBrief: latestBriefRow ? {
      materialChanges: Array.isArray(latestBriefRow.material_changes) ? latestBriefRow.material_changes : [],
      unknowns: Array.isArray(latestBriefRow.unknowns) ? latestBriefRow.unknowns : [],
    } : null,
    fingerprint: fingerprintClaims(currentClaims),
  }
}

async function ensureQuestion(desk: ResearchDeskDefinition, question: string): Promise<string> {
  const db = createServiceClient()
  const existing = await db.from('research_questions').select('id,status').eq('program_id', desk.programId).eq('question', question).maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data) {
    if (existing.data.status === 'archived') {
      const reopened = await db.from('research_questions').update({ status: 'open', updated_at: new Date().toISOString() }).eq('id', existing.data.id)
      if (reopened.error) throw reopened.error
    }
    return existing.data.id
  }

  const inserted = await db.from('research_questions').insert({ program_id: desk.programId, question, status: 'open' }).select('id').single()
  if (inserted.error) throw inserted.error
  return inserted.data.id
}

function epistemicTypeForClaim(claimType: string | null): IntelligenceFinding['epistemicType'] {
  if (claimType === 'finding') return 'source_claim'
  if (claimType === 'unknown') return 'unknown'
  return 'inference'
}

async function projectRunIntoIntelligence(args: {
  desk: ResearchDeskDefinition
  question: ResearchDeskQuestion
  runId: string
  materialChanges: string[]
}): Promise<void> {
  const db = createServiceClient()
  const claimsResult = await db.from('research_claims')
    .select('id,statement,claim_type,confidence,observed_at')
    .eq('run_id', args.runId)
  if (claimsResult.error) throw claimsResult.error

  const material = args.materialChanges.length > 0
  for (const claim of claimsResult.data ?? []) {
    const epistemicType = epistemicTypeForClaim(claim.claim_type)
    await ingestIntelligenceFinding({
      scope: { kind: 'operator' },
      domain: args.desk.domain,
      topic: args.question.question,
      claim: claim.statement,
      epistemicType,
      confidence: claim.confidence == null ? null : Number(claim.confidence),
      relevance: material ? 0.8 : 0.6,
      novelty: 0.6,
      materiality: material ? 0.8 : 0.4,
      observedAt: claim.observed_at ?? new Date().toISOString(),
      evidence: [{ claimId: claim.id, role: 'supports' }],
      provenance: { researchRunId: args.runId, researchDeskId: args.desk.id, researchQuestion: args.question.question },
    })
  }
}

function planner(mode: 'monitoring' | 'discovery', desk: ResearchDeskDefinition, intelligence: ExistingDeskIntelligence, remainingQueries: number): ResearchDeskQuestion[] {
  if (remainingQueries <= 0) return []
  if (mode === 'monitoring') {
    const recent = new Set(intelligence.recentQuestions.map(normalize))
    const available = desk.standingQuestions.filter((question) => !recent.has(normalize(question)))
    const pool = available.length ? available : desk.standingQuestions
    const limit = Math.max(1, Math.min(pool.length, Math.floor(remainingQueries * 0.6) || 1))
    return pool.slice(0, limit).map((question) => ({ question, mode: 'monitoring' as const, depth: 0 }))
  }

  const prompts = [
    `What material development inside ${desk.domain} is not adequately covered by the current standing questions but could change the standing mission: ${desk.standingMission}`,
    `What weak signal, non-obvious opportunity, or credible contradiction in ${desk.domain} deserves investigation even though it is outside the current consensus?`,
  ]
  return prompts.slice(0, Math.min(remainingQueries, 2)).map((question) => ({ question, mode: 'discovery' as const, depth: 0 }))
}

export async function runNextProductionResearchDesk(workerId: string) {
  const claimed = await claimDueResearchDesk(workerId)
  if (!claimed) return { status: 'idle' as const }

  // One routing session per desk cycle. The session-scoped failure memo is the
  // reason a zero-credit provider costs this cycle a single rejected call
  // instead of one per question per source.
  const session = createResearchProviderSession()
  const db = createServiceClient()

  const cycle = await runResearchDeskCycle(claimed, {
    store: createSupabaseResearchDeskStore(),
    intelligence: { read: readDeskIntelligence },
    planner: { plan: async ({ desk, intelligence, mode, remainingQueries }) => planner(mode, desk, intelligence, remainingQueries) },
    executor: {
      execute: async ({ desk, question }): Promise<ResearchDeskResearchResult> => {
        const questionId = await ensureQuestion(desk, question.question)
        const queued = await queueResearchRun(questionId, `research-desk:${desk.key}`)
        if (queued.status === 'running') throw new Error(`Research question already running: ${question.question}`)

        // Per-run provenance scope; the dead-provider memo stays on the session.
        const binding = session.beginRun()
        const startedAt = new Date().toISOString()
        const claimedRun = await db.from('research_runs').update({
          status: 'running',
          claimed_at: startedAt,
          claimed_by: workerId,
          started_at: startedAt,
          provider: binding.provider.name,
        }).eq('id', queued.id).eq('status', 'queued').select('id').maybeSingle()
        if (claimedRun.error) throw claimedRun.error
        if (!claimedRun.data) throw new Error(`Research run could not be claimed: ${queued.id}`)

        try {
          const run = await executeResearchRun({
            runId: queued.id,
            questionId,
            question: question.question,
            provider: binding.provider,
            synthesize: binding.synthesize,
          })

          const brief = await db.from('research_briefs').select('material_changes,conflicting_evidence').eq('run_id', queued.id).maybeSingle()
          if (brief.error) throw brief.error
          const materialChanges = Array.isArray(brief.data?.material_changes) ? brief.data.material_changes.filter((value): value is string => typeof value === 'string') : []
          const conflicting = Array.isArray(brief.data?.conflicting_evidence) && brief.data.conflicting_evidence.length > 0
          await projectRunIntoIntelligence({ desk, question, runId: queued.id, materialChanges })

          return {
            question,
            status: run.status,
            sourceCount: run.sourceCount,
            materialChanges,
            claims: conflicting ? [{ statement: 'Credible conflicting evidence exists in the latest research brief.', stance: 'contradicts' }] : [],
          }
        } finally {
          // Record routing on success and failure alike — a run that fell all
          // the way through the chain is exactly the one worth explaining.
          await recordResearchRoutingProvenance(queued.id, binding.provenance())
            .catch((error) => console.error('[research-desk] routing provenance write failed:', error))
        }
      },
    },
    evaluator: {
      evaluate: async ({ intelligence, results }) => {
        const refreshed = await readDeskIntelligence(await createSupabaseResearchDeskStore().getDesk(claimed.deskId) as ResearchDeskDefinition)
        const materialChanges = results.flatMap((result) => result.materialChanges ?? [])
        const contradictory = results.some((result) => result.claims?.some((claim) => claim.stance === 'contradicts'))
        const changedFingerprint = Boolean(refreshed.fingerprint && refreshed.fingerprint !== intelligence.fingerprint)
        const material = materialChanges.length > 0
        return {
          novel: changedFingerprint,
          material,
          contradictory,
          confidence: material ? 0.8 : changedFingerprint ? 0.7 : 0.5,
          relevance: material ? 0.8 : changedFingerprint ? 0.7 : 0.5,
          fingerprint: refreshed.fingerprint,
          summary: material
            ? `Material research changes detected: ${materialChanges.slice(0, 3).join(' | ')}`
            : changedFingerprint
              ? 'Research produced new evidence-backed claims without a material-change flag.'
              : 'No material change detected.',
        }
      },
    },
    scheduler: createSupabaseResearchDeskScheduler(),
  })

  return { status: 'processed' as const, deskId: claimed.deskId, wakeupKey: claimed.wakeupKey, cycle }
}
