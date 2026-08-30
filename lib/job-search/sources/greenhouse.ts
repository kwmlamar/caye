import type { RawJobPosting, RemoteType } from '../types'
import type { SourceAdapter } from './types'
import { stripHtml } from './html-text'

type GreenhouseJob = { id:number; title:string; updated_at?:string; absolute_url:string; requisition_id?:string|null; location?:{name?:string}|null; content?:string|null; offices?:{name?:string}[] }
type GreenhouseConfig = { boards?: unknown; maxAgeDays?: unknown; titleTerms?: unknown }

function inferRemoteType(locationName:string|null|undefined):RemoteType { if(!locationName)return'unknown'; const l=locationName.toLowerCase(); if(l.includes('remote'))return'remote'; if(l.includes('hybrid'))return'hybrid'; return'on_site' }
function normalizedMaxAgeDays(value:unknown):number { return typeof value==='number' && Number.isFinite(value) ? Math.max(1,Math.min(90,Math.floor(value))) : 30 }
function isFresh(updatedAt:string|undefined,maxAgeDays:number):boolean { if(!updatedAt)return true; const t=new Date(updatedAt).getTime(); if(Number.isNaN(t)||t>Date.now())return true; return Date.now()-t <= maxAgeDays*86400000 }

async function fetchBoard(boardToken:string,maxAgeDays:number,titleTerms:string[]):Promise<RawJobPosting[]> {
  const url=`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`
  const res=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)})
  if(!res.ok)throw new Error(`Greenhouse board "${boardToken}" fetch failed: ${res.status}`)
  const body=await res.json() as {jobs?:GreenhouseJob[]}
  return (body.jobs??[])
    .filter(job=>isFresh(job.updated_at,maxAgeDays))
    .filter(job=>titleTerms.length===0 || titleTerms.some(term=>job.title.toLowerCase().includes(term)))
    .map((job):RawJobPosting=>{ const locationName=job.location?.name??job.offices?.[0]?.name??null; const description=stripHtml(job.content); return {sourceKey:'greenhouse_public',sourceUrl:job.absolute_url,applyUrl:job.absolute_url,company:boardToken,title:job.title,requisitionId:job.requisition_id??String(job.id),location:locationName,remoteType:inferRemoteType(locationName),employmentType:null,salary:null,description,requirements:description,postedAt:job.updated_at??null} })
}

export const greenhouseAdapter:SourceAdapter={
  sourceKey:'greenhouse_public', adapterType:'greenhouse',
  async fetchCandidates(config){
    const c=config as GreenhouseConfig
    const boards=Array.isArray(c.boards)?c.boards.filter((b):b is string=>typeof b==='string'&&b.trim().length>0):[]
    if(boards.length===0)return{postings:[],errors:[]}
    const maxAgeDays=normalizedMaxAgeDays(c.maxAgeDays)
    const titleTerms=Array.isArray(c.titleTerms)?c.titleTerms.filter((t):t is string=>typeof t==='string').map(t=>t.trim().toLowerCase()).filter(Boolean):[]
    const results=await Promise.allSettled(boards.map(board=>fetchBoard(board,maxAgeDays,titleTerms)))
    return { postings:results.flatMap(r=>r.status==='fulfilled'?r.value:[]), errors:results.map((r,i)=>r.status==='rejected'?`greenhouse board "${boards[i]}": ${r.reason instanceof Error?r.reason.message:String(r.reason)}`:null).filter((e):e is string=>e!==null) }
  }
}
