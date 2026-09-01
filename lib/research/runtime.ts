import 'server-only'
import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'

export type ResearchSourceQuality = 'official' | 'academic-preprint' | 'academic-institution' | 'community' | 'unknown'
export type ResearchSearchResult = { url: string; title?: string; snippet?: string; publisher?: string }
export type ResearchFetchedSource = ResearchSearchResult & { content: string; fetchedAt: string; contentHash?: string; quality?: ResearchSourceQuality }
export interface ResearchProvider {
  readonly name: string
  search(query: string, options?: { limit?: number }): Promise<ResearchSearchResult[]>
  fetch(result: ResearchSearchResult): Promise<ResearchFetchedSource>
}

export function classifyResearchSourceQuality(source: Pick<ResearchSearchResult, 'url'>): ResearchSourceQuality {
  let hostname: string
  try {
    hostname = new URL(source.url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return 'unknown'
  }

  if (hostname === 'arxiv.org' || hostname.endsWith('.arxiv.org')) return 'academic-preprint'
  if (hostname.endsWith('.gov') || hostname.includes('.gov.')) return 'official'
  if (hostname.endsWith('.edu') || hostname.includes('.edu.')) return 'academic-institution'
  if (hostname === 'medium.com' || hostname.endsWith('.medium.com') || hostname === 'substack.com' || hostname.endsWith('.substack.com')) return 'community'
  return 'unknown'
}

function normalizeSourceUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString().replace(/\/$/, '').toLowerCase()
  } catch {
    return value.trim().replace(/\/$/, '').toLowerCase()
  }
}

export function excludePreviouslyObservedSources(results: ResearchSearchResult[], priorUrls: Iterable<string>): ResearchSearchResult[] {
  const excluded = new Set([...priorUrls].map(normalizeSourceUrl))
  if (!excluded.size) return results
  return results.filter((result) => !excluded.has(normalizeSourceUrl(result.url)))
}

async function getOperatorResearchQuestionIds(): Promise<string[]> {
  const db = createServiceClient()
  const { data, error } = await db
    .from('research_programs')
    .select('research_questions(id)')
    .eq('scope', 'operator')
  if (error) throw error

  return (data ?? []).flatMap((program) =>
    (program.research_questions ?? []).map((question: { id: string }) => question.id),
  )
}

async function assertOperatorResearchQuestion(questionId: string) {
  const db = createServiceClient()
  const question = await db
    .from('research_questions')
    .select('id,status,program_id')
    .eq('id', questionId)
    .maybeSingle()
  if (question.error) throw question.error
  if (!question.data || question.data.status === 'archived') throw new Error('Research question is unavailable')

  const program = await db
    .from('research_programs')
    .select('id,scope,status')
    .eq('id', question.data.program_id)
    .maybeSingle()
  if (program.error) throw program.error
  if (!program.data || program.data.scope !== 'operator' || program.data.status === 'archived') {
    throw new Error('Research question is outside founder operator scope')
  }

  return question.data
}

export async function queueResearchRun(questionId: string, triggerSource = 'founder') {
  const db = createServiceClient()
  await assertOperatorResearchQuestion(questionId)

  const { data, error } = await db.from('research_runs').insert({ question_id: questionId, status: 'queued', trigger_source: triggerSource }).select('id,status,question_id,created_at').single()
  if (error) {
    if (error.code === '23505') {
      const existing = await db.from('research_runs').select('id,status,question_id,created_at').eq('question_id', questionId).in('status', ['queued','running']).order('created_at',{ascending:false}).limit(1).maybeSingle()
      if (existing.data) return existing.data
    }
    throw error
  }
  return data
}

export async function claimResearchRun(workerId: string) {
  const db = createServiceClient()
  const { data, error } = await db.rpc('claim_research_run', { p_worker: workerId })
  if (error) throw error
  return data?.[0] ?? null
}

export async function getResearchStatus(goalId?: string) {
  const db = createServiceClient()
  let programs = db
    .from('research_programs')
    .select('id,goal_id,title,status,updated_at,research_questions(id,question,status,updated_at,research_runs(id,status,created_at,started_at,completed_at,provider))')
    .eq('scope', 'operator')
  if (goalId) programs = programs.eq('goal_id', goalId)
  const { data, error } = await programs.order('updated_at',{ascending:false})
  if (error) throw error
  return data ?? []
}

export async function getAllCurrentClaims() {
  const db = createServiceClient()
  const questionIds = await getOperatorResearchQuestionIds()
  if (!questionIds.length) return []

  const { data, error } = await db
    .from('research_claims')
    .select('id,question_id,statement,claim_type,confidence,source_quality,status,valid_from,valid_until,superseded_by,research_claim_evidence(source_id,stance)')
    .in('question_id', questionIds)
    .in('status',['current','contested'])
    .order('created_at',{ascending:false})
  if (error) throw error
  return data ?? []
}

export async function getCurrentClaims(questionId: string) {
  const questionIds = await getOperatorResearchQuestionIds()
  if (!questionIds.includes(questionId)) throw new Error('Research question is outside founder operator scope')

  const db = createServiceClient()
  const { data, error } = await db
    .from('research_claims')
    .select('id,question_id,statement,claim_type,confidence,source_quality,status,valid_from,valid_until,superseded_by,research_claim_evidence(source_id,stance)')
    .eq('question_id', questionId)
    .in('status',['current','contested'])
    .order('created_at',{ascending:false})
  if (error) throw error
  return data ?? []
}

export async function getLatestBrief(questionId: string) {
  const questionIds = await getOperatorResearchQuestionIds()
  if (!questionIds.includes(questionId)) throw new Error('Research question is outside founder operator scope')

  const db = createServiceClient()
  const { data, error } = await db.from('research_briefs').select('*').eq('question_id',questionId).order('revision',{ascending:false}).limit(1).maybeSingle()
  if (error) throw error
  return data
}

export async function getLatestBriefs() {
  const db = createServiceClient()
  const questionIds = await getOperatorResearchQuestionIds()
  if (!questionIds.length) return []

  const { data, error } = await db
    .from('research_briefs')
    .select('*')
    .in('question_id', questionIds)
    .order('created_at',{ascending:false})
  if (error) throw error
  const latest = new Map<string, (typeof data)[number]>()
  for (const brief of data ?? []) if (!latest.has(brief.question_id)) latest.set(brief.question_id, brief)
  return [...latest.values()]
}

/**
 * Supabase/Postgrest rejections are plain objects, not Errors, so String(err)
 * on one yields the literal "[object Object]" — which is what several failed
 * production research runs recorded, leaving nothing to diagnose. Preserve the
 * actual code/message/details instead.
 */
export function describeResearchError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    const parts = [value.code, value.message, value.details, value.hint]
      .filter((part): part is string | number => part !== null && part !== undefined && part !== '')
      .map(String)
    if (parts.length) return parts.join(' | ')
    try {
      return JSON.stringify(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }
  return String(error)
}

function sourceHash(source: ResearchFetchedSource): string {
  return source.contentHash ?? createHash('sha256').update(`${source.url}\n${source.content}`).digest('hex')
}

async function priorCrossCheckSourceUrls(questionId: string): Promise<string[]> {
  const db = createServiceClient()
  const { data: question, error: questionError } = await db.from('research_questions')
    .select('investigation_origin,parent_question_id')
    .eq('id', questionId)
    .maybeSingle()
  if (questionError) throw questionError
  if (question?.investigation_origin !== 'autonomous_cross_check' || !question.parent_question_id) return []

  const { data: runs, error: runsError } = await db.from('research_runs').select('id').eq('question_id', question.parent_question_id)
  if (runsError) throw runsError
  const runIds = (runs ?? []).map((run) => run.id)
  if (!runIds.length) return []

  const { data: edges, error: edgesError } = await db.from('research_run_sources').select('source_id').in('run_id', runIds)
  if (edgesError) throw edgesError
  const sourceIds = [...new Set((edges ?? []).map((edge) => edge.source_id))]
  if (!sourceIds.length) return []

  const { data: sources, error: sourcesError } = await db.from('research_sources').select('canonical_url').in('id', sourceIds)
  if (sourcesError) throw sourcesError
  return (sources ?? []).map((source) => source.canonical_url).filter((url): url is string => typeof url === 'string' && url.length > 0)
}

// Search is a sensor, not the architecture. Observations are durable before
// synthesis, while claims + evidence edges + brief revision commit atomically.
export async function executeResearchRun(args: {
  runId: string
  questionId: string
  question: string
  provider: ResearchProvider
  synthesize: (input: { question: string; sources: Array<{ id:string; source:ResearchFetchedSource }> }) => Promise<{
    claims:Array<{ statement:string; claimType?:'finding'|'hypothesis'|'implication'|'unknown'; confidence?:number; sourceQuality?:string; sourceIds:string[] }>
    brief:string
    strongestEvidence?:unknown[]
    conflictingEvidence?:unknown[]
    unknowns?:string[]
    materialChanges?:string[]
    implications?:string[]
    recommendations?:string[]
  }>
}) {
  const db = createServiceClient()
  const observed:Array<{id:string;source:ResearchFetchedSource}>=[]
  try {
    const priorUrls = await priorCrossCheckSourceUrls(args.questionId)
    const searchLimit = priorUrls.length ? 12 : 8
    const rawResults = await args.provider.search(args.question,{limit:searchLimit})
    const results = excludePreviouslyObservedSources(rawResults, priorUrls).slice(0, 8)
    const fetchFailures: string[] = []

    if (priorUrls.length && !results.length) {
      throw new Error('Independent cross-check found no source candidates outside the parent investigation evidence set')
    }

    for (const result of results) {
      let source: ResearchFetchedSource
      try {
        source = await args.provider.fetch(result)
      } catch (error) {
        fetchFailures.push(`${result.url}: ${describeResearchError(error)}`)
        continue
      }

      const quality = classifyResearchSourceQuality(source)
      source = { ...source, quality }
      const hash = sourceHash(source)
      const { data:stored, error } = await db.from('research_sources').upsert({
        canonical_url:source.url,
        title:source.title??null,
        publisher:source.publisher??null,
        fetched_at:source.fetchedAt,
        content_hash:hash,
        snapshot:{content:source.content},
        quality,
      },{onConflict:'canonical_url,content_hash'}).select('id').single()
      if (error) throw error
      const edge = await db.from('research_run_sources').upsert({run_id:args.runId,source_id:stored.id})
      if (edge.error) throw edge.error
      observed.push({id:stored.id,source:{...source,contentHash:hash}})
    }

    if (!observed.length) {
      const detail = fetchFailures.length ? ` First fetch failure: ${fetchFailures[0]}` : ''
      throw new Error(`Research run produced no durable source evidence.${detail}`)
    }

    const synthesis = await args.synthesize({question:args.question,sources:observed})
    const observedIds = new Set(observed.map(({id}) => id))
    if (!synthesis.claims.length) throw new Error('Research synthesis returned no claims')
    for (const claim of synthesis.claims) {
      if (!claim.statement.trim()) throw new Error('Research claim statement is empty')
      if (!claim.sourceIds.length) throw new Error('Material research claim lacks evidence')
      if (claim.sourceIds.some((id) => !observedIds.has(id))) throw new Error('Research claim cites evidence not observed by this run')
    }

    const { data:revision, error } = await db.rpc('persist_research_synthesis', {
      p_run_id: args.runId,
      p_question_id: args.questionId,
      p_provider: args.provider.name,
      p_claims: synthesis.claims.map((claim) => ({
        statement: claim.statement,
        claim_type: claim.claimType ?? 'finding',
        confidence: claim.confidence ?? null,
        source_quality: claim.sourceQuality ?? null,
        evidence: claim.sourceIds,
      })),
      p_brief: {
        current_understanding: synthesis.brief,
        strongest_evidence: synthesis.strongestEvidence ?? [],
        conflicting_evidence: synthesis.conflictingEvidence ?? [],
        unknowns: synthesis.unknowns ?? [],
        material_changes: synthesis.materialChanges ?? [],
        implications: synthesis.implications ?? [],
        recommendations: synthesis.recommendations ?? [],
      },
    })
    if (error) throw error
    return {status:'completed' as const,sourceCount:observed.length,skippedSourceCount:fetchFailures.length,revision:Number(revision)}
  } catch (error) {
    await db.from('research_runs').update({status:observed.length?'partial':'failed',completed_at:new Date().toISOString(),provider:args.provider.name,error:describeResearchError(error)}).eq('id',args.runId).neq('status','completed')
    throw error
  }
}
