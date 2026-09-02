import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getChannelState, SLOT_LABEL, slotForChannelType } from '@/lib/channels/slots'

export interface FeedEvent { id:number; at:string; type:string; actorKind:string; isFailure:boolean; conversationId:string|null; customer:string|null; channel:string|null; detail:Record<string,unknown> }
export interface Coverage { live:string[]; gated:{channel:string;reason:string}[]; missing:string[]; isLive:boolean; lastReceived:Record<string,string|null> }
export interface WorkspaceFeed { windowHours:number; events:FeedEvent[]; quiet:boolean; coverage:Coverage }
export function isReportable(e:{actorKind:string;isFailure:boolean}):boolean { return e.actorKind === 'outside' || e.isFailure }
const REPORTABLE_SQL_FILTER='actor_kind.eq.outside,is_failure.eq.true'
export function isBounceAddress(address:string|null|undefined):boolean { if(!address)return false; const a=address.toLowerCase(); return a.startsWith('mailer-daemon@')||a.startsWith('postmaster@')||a.startsWith('no-reply@')||a.startsWith('noreply@')||a.includes('mailer-daemon') }
interface RawEvent { id:number; occurred_at:string; type:string; actor_kind:string; is_failure:boolean; conversation_id:string|null; payload:Record<string,unknown>|null }
interface ConvContext { customer:string|null; address:string|null; channel:string }

async function attachConversationContext(supabase:ReturnType<typeof createServiceClient>,rows:RawEvent[]):Promise<Map<string,ConvContext>>{
  const ids=[...new Set(rows.map(r=>r.conversation_id).filter((v):v is string=>!!v))]; const out=new Map<string,ConvContext>(); if(!ids.length)return out
  const {data}=await supabase.from('unified_conversations').select('id, customer_name, customer_id, channel_type').in('id',ids)
  for(const c of (data??[]) as {id:string;customer_name:string|null;customer_id:string|null;channel_type:string}[]) out.set(c.id,{customer:c.customer_name||c.customer_id,address:c.customer_id,channel:c.channel_type})
  return out
}
function toFeedEvent(r:RawEvent,ctx:Map<string,ConvContext>):FeedEvent{
  const conv=r.conversation_id?ctx.get(r.conversation_id):undefined; const payload=r.payload??{}; const bounced=r.type==='message.inbound'&&isBounceAddress(conv?.address)
  return {id:r.id,at:r.occurred_at,type:bounced?'message.bounced':r.type,actorKind:r.actor_kind,isFailure:r.is_failure||bounced,conversationId:r.conversation_id,customer:conv?.customer??(payload.customer as string|null)??null,channel:conv?.channel??(payload.channel as string|null)??null,detail:payload}
}
export async function getCoverage(workspaceId:string):Promise<Coverage>{
  const supabase=createServiceClient(); const state=await getChannelState(supabase,workspaceId)
  const {data:accounts}=await supabase.from('connected_accounts').select('id, channel_type').eq('user_id',workspaceId).eq('is_active',true)
  const rows=(accounts??[]) as {id:string;channel_type:string}[]; const lastReceived:Record<string,string|null>={}; for(const slot of state.connected)lastReceived[SLOT_LABEL[slot]]=null
  if(rows.length){ const {data:convs}=await supabase.from('unified_conversations').select('channel_type, last_message_at').in('connected_account_id',rows.map(r=>r.id)).not('last_message_at','is',null).order('last_message_at',{ascending:false}).limit(200)
    for(const c of (convs??[]) as {channel_type:string;last_message_at:string}[]){const slot=slotForChannelType(c.channel_type);if(!slot)continue;const label=SLOT_LABEL[slot];if(lastReceived[label]==null)lastReceived[label]=c.last_message_at}}
  return {live:state.connected.map(s=>SLOT_LABEL[s]),gated:state.gated.map(g=>({channel:SLOT_LABEL[g.slot],reason:g.reason})),missing:state.missing.map(s=>SLOT_LABEL[s]),isLive:state.isLive,lastReceived}
}

/** External domain events keep source chronology in occurred_at, but perception
 * freshness is when Caye first observed them. Ordinary events remain governed
 * solely by occurred_at. This makes outage catch-up visible without resurfacing
 * arbitrary historical activity. Bootstrap stays silent because actor_kind is system. */
export async function getWorkspaceFeed(workspaceId:string,opts?:{hours?:number;limit?:number}):Promise<WorkspaceFeed>{
  const supabase=createServiceClient(); const hours=Math.min(opts?.hours??24,24*30); const limit=opts?.limit??30; const cutoff=new Date(Date.now()-hours*3600000).toISOString()
  const select='id, occurred_at, type, actor_kind, is_failure, conversation_id, payload'
  const [{data:ordinary},{data:domainObserved}]=await Promise.all([
    supabase.from('workspace_events').select(select).eq('workspace_id',workspaceId).gte('occurred_at',cutoff).or(REPORTABLE_SQL_FILTER).order('occurred_at',{ascending:false}).limit(limit),
    supabase.from('workspace_events').select(select).eq('workspace_id',workspaceId).like('type','domain.%').gte('payload->>observed_at',cutoff).or(REPORTABLE_SQL_FILTER).order('occurred_at',{ascending:false}).limit(limit),
  ])
  const byId=new Map<number,RawEvent>(); for(const r of [...((ordinary??[]) as RawEvent[]),...((domainObserved??[]) as RawEvent[])])byId.set(r.id,r)
  const rows=[...byId.values()].sort((a,b)=>{
    const af=a.type.startsWith('domain.')&&typeof a.payload?.observed_at==='string'?String(a.payload.observed_at):a.occurred_at
    const bf=b.type.startsWith('domain.')&&typeof b.payload?.observed_at==='string'?String(b.payload.observed_at):b.occurred_at
    return bf.localeCompare(af)
  }).slice(0,limit)
  const ctx=await attachConversationContext(supabase,rows); const events=rows.map(r=>toFeedEvent(r,ctx)).filter(isReportable); const coverage=await getCoverage(workspaceId)
  return {windowHours:hours,events,quiet:events.length===0,coverage}
}

export interface InboundThread { conversationId:string|null; customer:string|null; channel:string|null; at:string; preview:string|null }
export async function getRecentInbound(workspaceId:string,opts?:{limit?:number}):Promise<{threads:InboundThread[];bounces:number;coverage:Coverage}>{
  const supabase=createServiceClient(); const limit=opts?.limit??10
  const {data}=await supabase.from('workspace_events').select('id, occurred_at, type, actor_kind, is_failure, conversation_id, payload').eq('workspace_id',workspaceId).eq('type','message.inbound').order('occurred_at',{ascending:false}).limit(limit*5)
  const rows=(data??[]) as RawEvent[]; const ctx=await attachConversationContext(supabase,rows); const seen=new Set<string>(); const threads:InboundThread[]=[]; let bounces=0
  for(const r of rows){const key=r.conversation_id??`evt:${r.id}`;if(seen.has(key))continue;seen.add(key);const conv=r.conversation_id?ctx.get(r.conversation_id):undefined;if(isBounceAddress(conv?.address)){bounces++;continue}threads.push({conversationId:r.conversation_id,customer:conv?.customer??null,channel:conv?.channel??null,at:r.occurred_at,preview:(r.payload?.preview as string|null)??null});if(threads.length>=limit)break}
  return {threads,bounces,coverage:await getCoverage(workspaceId)}
}
