import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { IntelligenceScope, assertIntelligenceScope } from './identity'

function scoped(query:any, scope:IntelligenceScope) {
  assertIntelligenceScope(scope)
  if(scope.kind==='workspace') return query.eq('scope','workspace').eq('workspace_id',scope.workspaceId)
  return query.eq('scope',scope.kind).is('workspace_id',null)
}

export async function latestIntelligence(args:{scope:IntelligenceScope;domain:string;limit?:number}) {
  const db=createServiceClient()
  let q=db.from('intelligence_items').select('*').eq('domain',args.domain).in('status',['current','contested']).order('observed_at',{ascending:false}).limit(args.limit??50)
  q=scoped(q,args.scope); const {data,error}=await q; if(error) throw error; return data??[]
}
export async function highMaterialityIntelligence(args:{scope:IntelligenceScope;domain?:string;minimum?:number;limit?:number}) {
  const db=createServiceClient(); let q=db.from('intelligence_items').select('*').in('status',['current','contested']).gte('materiality',args.minimum??0.7).order('materiality',{ascending:false}).order('relevance',{ascending:false}).order('observed_at',{ascending:false}).limit(args.limit??50)
  if(args.domain) q=q.eq('domain',args.domain); q=scoped(q,args.scope); const {data,error}=await q; if(error) throw error; return data??[]
}
export async function recentlyChangedIntelligence(args:{scope:IntelligenceScope;since:string;limit?:number}) {
  const db=createServiceClient(); let q=db.from('intelligence_items').select('*,intelligence_relations!intelligence_relations_from_item_id_fkey(*)').gte('updated_at',args.since).order('updated_at',{ascending:false}).limit(args.limit??50); q=scoped(q,args.scope); const {data,error}=await q; if(error) throw error; return data??[]
}
export async function unresolvedContradictions(args:{scope:IntelligenceScope;limit?:number}) {
  const db=createServiceClient(); const {data:relations,error}=await db.from('intelligence_relations').select('*,from:intelligence_items!intelligence_relations_from_item_id_fkey(*),to:intelligence_items!intelligence_relations_to_item_id_fkey(*)').eq('relation_type','contradicts').eq('status','active').limit(args.limit??50); if(error) throw error
  return (relations??[]).filter((r:any)=> itemVisible(r.from,args.scope) && itemVisible(r.to,args.scope))
}
function itemVisible(item:any,scope:IntelligenceScope){ return scope.kind==='workspace' ? item.scope==='workspace'&&item.workspace_id===scope.workspaceId : item.scope===scope.kind&&item.workspace_id===null }
export async function evidenceForIntelligence(itemId:string,scope:IntelligenceScope) {
  const db=createServiceClient(); let itemQ=db.from('intelligence_items').select('*').eq('id',itemId); itemQ=scoped(itemQ,scope); const item=await itemQ.maybeSingle(); if(item.error) throw item.error; if(!item.data) return null
  const {data,error}=await db.from('intelligence_item_claims').select('role,research_claims(*,research_claim_evidence(*,research_sources(*)))').eq('intelligence_item_id',itemId); if(error) throw error; return {item:item.data,evidence:data??[]}
}
export async function relatedIntelligence(itemId:string,scope:IntelligenceScope) {
  const db=createServiceClient(); const {data,error}=await db.from('intelligence_relations').select('*,from:intelligence_items!intelligence_relations_from_item_id_fkey(*),to:intelligence_items!intelligence_relations_to_item_id_fkey(*)').or(`from_item_id.eq.${itemId},to_item_id.eq.${itemId}`).eq('status','active'); if(error) throw error
  return (data??[]).filter((r:any)=>itemVisible(r.from,scope)&&itemVisible(r.to,scope))
}
export async function staleIntelligence(args:{scope:IntelligenceScope;asOf?:string;limit?:number}) {
  const db=createServiceClient(); const now=args.asOf??new Date().toISOString(); let q=db.from('intelligence_items').select('*').in('status',['current','contested']).or(`refresh_after.lte.${now},valid_until.lte.${now}`).order('refresh_after',{ascending:true}).limit(args.limit??50); q=scoped(q,args.scope); const {data,error}=await q; if(error) throw error; return data??[]
}

/**
 * Append-only confidence changes for beliefs visible in exactly one intelligence scope.
 * Visibility is resolved through the canonical item first; revision rows never widen scope.
 */
export async function recentBeliefRevisions(args:{scope:IntelligenceScope;since:string;limit?:number}) {
  const db=createServiceClient()
  const {data,error}=await db
    .from('intelligence_belief_revisions')
    .select('*,item:intelligence_items!intelligence_belief_revisions_intelligence_item_id_fkey(*)')
    .gte('created_at',args.since)
    .order('created_at',{ascending:false})
    .limit(args.limit??50)
  if(error) throw error
  return (data??[]).filter((revision:any)=>itemVisible(revision.item,args.scope))
}

export type StrategicIntelligencePriority = {
  kind:'contradiction'|'stale_high_materiality'
  statement:string
  confidence:number|null
  materiality:number
  observedAt:string|null
  domains:string[]
}

/**
 * Deterministic read-side prioritization for the research layer. This does not create
 * new graph edges or research runs. It ranks already-grounded unresolved state so
 * the canonical research runtime can decide what deserves the next bounded pass.
 */
export async function strategicIntelligencePriorities(args:{scope:IntelligenceScope;asOf?:string;limit?:number}) {
  const limit=args.limit??20
  const [contradictions,stale]=await Promise.all([
    unresolvedContradictions({scope:args.scope,limit}),
    staleIntelligence({scope:args.scope,asOf:args.asOf,limit}),
  ])
  const priorities:StrategicIntelligencePriority[]=[]
  for(const relation of contradictions){
    const from=relation.from
    const to=relation.to
    if(!from||!to) continue
    priorities.push({
      kind:'contradiction',
      statement:`Resolve contradiction: ${String(from.canonical_claim??'')} ↔ ${String(to.canonical_claim??'')}`,
      confidence:relation.confidence==null?null:Number(relation.confidence),
      materiality:Math.max(Number(from.materiality??0),Number(to.materiality??0)),
      observedAt:String(relation.created_at??from.observed_at??to.observed_at??'')||null,
      domains:[...new Set([String(from.domain??''),String(to.domain??'')].filter(Boolean))],
    })
  }
  for(const item of stale){
    const materiality=Number(item.materiality??0)
    if(materiality<0.6) continue
    priorities.push({
      kind:'stale_high_materiality',
      statement:`Refresh evidence for: ${String(item.canonical_claim??'')}`,
      confidence:item.confidence==null?null:Number(item.confidence),
      materiality,
      observedAt:String(item.observed_at??'')||null,
      domains:[String(item.domain??'')].filter(Boolean),
    })
  }
  return priorities
    .filter((priority)=>priority.statement.trim().length>0)
    .sort((a,b)=>b.materiality-a.materiality)
    .slice(0,limit)
}
