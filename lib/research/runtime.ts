import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type ResearchSearchResult = { url: string; title?: string; snippet?: string; publisher?: string }
export type ResearchFetchedSource = ResearchSearchResult & { content: string; fetchedAt: string; contentHash?: string }
export interface ResearchProvider {
  readonly name: string
  search(query: string, options?: { limit?: number }): Promise<ResearchSearchResult[]>
  fetch(result: ResearchSearchResult): Promise<ResearchFetchedSource>
}

export async function queueResearchRun(questionId: string, triggerSource = 'founder') {
  const db = createServiceClient()
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
  let programs = db.from('research_programs').select('id,goal_id,title,status,updated_at,research_questions(id,question,status,updated_at)')
  if (goalId) programs = programs.eq('goal_id', goalId)
  const { data, error } = await programs.order('updated_at',{ascending:false})
  if (error) throw error
  return data ?? []
}

export async function getCurrentClaims(questionId: string) {
  const db = createServiceClient()
  const { data, error } = await db.from('research_claims').select('id,statement,claim_type,confidence,source_quality,status,valid_from,valid_until,superseded_by,research_claim_evidence(count)').eq('question_id',questionId).in('status',['current','contested']).order('created_at',{ascending:false})
  if (error) throw error
  return data ?? []
}

export async function getLatestBrief(questionId: string) {
  const db = createServiceClient()
  const { data, error } = await db.from('research_briefs').select('*').eq('question_id',questionId).order('revision',{ascending:false}).limit(1).maybeSingle()
  if (error) throw error
  return data
}

// The worker deliberately accepts a provider. Search is a sensor, not the architecture.
// Evidence is persisted before any synthesis callback runs, so partial failures remain honest.
export async function executeResearchRun(args: {
  runId: string; questionId: string; question: string; provider: ResearchProvider;
  synthesize: (input: { question: string; sources: Array<{ id:string; source:ResearchFetchedSource }> }) => Promise<{ claims:Array<{statement:string; claimType?:'finding'|'hypothesis'|'implication'|'unknown'; confidence?:number; sourceIds:string[]}>; brief:string; unknowns?:string[]; implications?:string[]; recommendations?:string[] }>
}) {
  const db = createServiceClient(); const observed:Array<{id:string;source:ResearchFetchedSource}>=[]
  try {
    const results = await args.provider.search(args.question,{limit:8})
    for (const result of results) {
      const source = await args.provider.fetch(result)
      const { data:stored, error } = await db.from('research_sources').upsert({ canonical_url:source.url,title:source.title??null,publisher:source.publisher??null,fetched_at:source.fetchedAt,content_hash:source.contentHash??null,snapshot:{content:source.content},quality:'unknown' },{onConflict:'canonical_url,content_hash'}).select('id').single()
      if (error) throw error
      await db.from('research_run_sources').upsert({run_id:args.runId,source_id:stored.id})
      observed.push({id:stored.id,source})
    }
    const synthesis = await args.synthesize({question:args.question,sources:observed})
    for (const claim of synthesis.claims) {
      const { data:c,error }=await db.from('research_claims').insert({question_id:args.questionId,run_id:args.runId,statement:claim.statement,claim_type:claim.claimType??'finding',confidence:claim.confidence??null,provenance:{provider:args.provider.name}}).select('id').single(); if(error) throw error
      if (!claim.sourceIds.length) throw new Error('Material research claim lacks evidence')
      const edges=claim.sourceIds.map(source_id=>({claim_id:c.id,source_id,stance:'supports'})); const edgeResult=await db.from('research_claim_evidence').insert(edges); if(edgeResult.error) throw edgeResult.error
    }
    const latest=await db.from('research_briefs').select('revision').eq('question_id',args.questionId).order('revision',{ascending:false}).limit(1).maybeSingle(); const revision=(latest.data?.revision??0)+1
    const brief=await db.from('research_briefs').insert({question_id:args.questionId,run_id:args.runId,revision,current_understanding:synthesis.brief,unknowns:synthesis.unknowns??[],implications:synthesis.implications??[],recommendations:synthesis.recommendations??[],provenance:{provider:args.provider.name,source_ids:observed.map(x=>x.id)}}); if(brief.error) throw brief.error
    await db.from('research_runs').update({status:'completed',completed_at:new Date().toISOString(),provider:args.provider.name}).eq('id',args.runId)
    return {status:'completed' as const,sourceCount:observed.length,revision}
  } catch (error) {
    await db.from('research_runs').update({status:observed.length?'partial':'failed',completed_at:new Date().toISOString(),provider:args.provider.name,error:error instanceof Error?error.message:String(error)}).eq('id',args.runId)
    throw error
  }
}