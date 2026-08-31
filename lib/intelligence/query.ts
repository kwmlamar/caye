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
