import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type {
  ArtifactModality,
  BusinessArtifactObservationRow,
  BusinessArtifactRelationRow,
  BusinessArtifactRow,
} from './types'

/**
 * Retrieval layer for Multimodal Business Memory (#87).
 *
 * Hybrid retrieval: structured filters (workspace/sender/conversation/date/
 * modality — always applied, always workspace-scoped) + a semantic overlay
 * (lowercased term-overlap scoring over description/visible_text/full_text/
 * filename/summary/relation labels). Same tradeoff as
 * query-business-knowledge.ts's scoreFact: no embeddings/pgvector in this
 * PR — the repo has an explicit, documented precedent for preferring
 * term-overlap/LLM-judged matching over vector search at current per-
 * workspace scale (see business-fact-semantic-match.ts's own doc comment).
 * pgvector is available as an extension but not enabled; revisit if/when
 * artifact volume actually justifies the infra cost, exactly the same
 * judgment call already made for business_facts.
 *
 * Every result resolves back to a durable business_artifacts row — this
 * never answers from an opaque similarity score alone.
 */

export interface ArtifactSearchFilters {
  workspaceId: string
  query?: string
  modality?: ArtifactModality
  conversationId?: string
  senderOperatorAllowlistId?: number
  senderContactId?: string
  dateFromISO?: string
  dateToISO?: string
  /** 'latest' = most recent match. 'second_most_recent' = the one before that — for "the second photo". */
  ordinal?: 'latest' | 'second_most_recent'
  limit?: number
}

export interface ArtifactSearchResultItem {
  artifact: BusinessArtifactRow
  matchedObservations: BusinessArtifactObservationRow[]
  confirmedRelations: BusinessArtifactRelationRow[]
  score: number
}

function scoreText(query: string, haystack: string): number {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
  if (terms.length === 0) return 0
  const lower = haystack.toLowerCase()
  let score = 0
  for (const t of terms) if (lower.includes(t)) score += 1
  return score
}

/** Excludes tombstoned/deleted artifacts from ordinary retrieval — explicit retention policy (#9), never silently exposed. */
function activeRetentionFilter<T extends { retention_status: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.retention_status === 'active')
}

export async function searchArtifacts(filters: ArtifactSearchFilters): Promise<ArtifactSearchResultItem[]> {
  const supabase = createServiceClient()
  let q = supabase
    .from('business_artifacts')
    .select('*')
    .eq('workspace_id', filters.workspaceId)
    .neq('retention_status', 'deleted')

  if (filters.modality) q = q.eq('modality', filters.modality)
  if (filters.conversationId) q = q.eq('conversation_id', filters.conversationId)
  if (filters.senderOperatorAllowlistId !== undefined) q = q.eq('sender_operator_allowlist_id', filters.senderOperatorAllowlistId)
  if (filters.senderContactId) q = q.eq('sender_contact_id', filters.senderContactId)
  if (filters.dateFromISO) q = q.gte('received_at', filters.dateFromISO)
  if (filters.dateToISO) q = q.lte('received_at', filters.dateToISO)

  const { data, error } = await q.order('received_at', { ascending: false }).limit(200)
  if (error || !data) return []

  const artifacts = activeRetentionFilter(data as BusinessArtifactRow[])
  if (artifacts.length === 0) return []

  const artifactIds = artifacts.map((a) => a.id)
  const [{ data: observations }, { data: relations }] = await Promise.all([
    supabase
      .from('business_artifact_observations')
      .select('*')
      .in('artifact_id', artifactIds)
      .is('superseded_at', null),
    supabase
      .from('business_artifact_relations')
      .select('*')
      .in('artifact_id', artifactIds)
      .eq('status', 'confirmed')
      .is('superseded_at', null),
  ])

  const obsByArtifact = new Map<string, BusinessArtifactObservationRow[]>()
  for (const o of (observations ?? []) as BusinessArtifactObservationRow[]) {
    const list = obsByArtifact.get(o.artifact_id) ?? []
    list.push(o)
    obsByArtifact.set(o.artifact_id, list)
  }
  const relByArtifact = new Map<string, BusinessArtifactRelationRow[]>()
  for (const r of (relations ?? []) as BusinessArtifactRelationRow[]) {
    const list = relByArtifact.get(r.artifact_id) ?? []
    list.push(r)
    relByArtifact.set(r.artifact_id, list)
  }

  let results: ArtifactSearchResultItem[] = artifacts.map((artifact) => {
    const obs = obsByArtifact.get(artifact.id) ?? []
    const rels = relByArtifact.get(artifact.id) ?? []
    let score = 0
    if (filters.query) {
      score += scoreText(filters.query, artifact.filename ?? '')
      for (const o of obs) {
        score += scoreText(filters.query, JSON.stringify(o.content))
      }
      for (const r of rels) {
        score += scoreText(filters.query, r.label ?? '') * 2 // operator-confirmed labels weigh more than raw model text
      }
    }
    return { artifact, matchedObservations: obs, confirmedRelations: rels, score }
  })

  if (filters.query) {
    results = results.filter((r) => r.score > 0).sort((a, b) => b.score - a.score)
  }
  // received_at desc is already the base order — preserved when no query filter narrows it.

  if (filters.ordinal === 'latest') results = results.slice(0, 1)
  if (filters.ordinal === 'second_most_recent') results = results.slice(1, 2)

  return results.slice(0, filters.limit ?? 10)
}

export async function getArtifactDetail(
  workspaceId: string,
  artifactId: string
): Promise<{
  artifact: BusinessArtifactRow
  observations: BusinessArtifactObservationRow[]
  relations: BusinessArtifactRelationRow[]
} | null> {
  const supabase = createServiceClient()
  const { data: artifact } = await supabase
    .from('business_artifacts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', artifactId)
    .maybeSingle()
  if (!artifact) return null

  const [{ data: observations }, { data: relations }] = await Promise.all([
    supabase
      .from('business_artifact_observations')
      .select('*')
      .eq('artifact_id', artifactId)
      .is('superseded_at', null)
      .order('created_at', { ascending: false }),
    supabase
      .from('business_artifact_relations')
      .select('*')
      .eq('artifact_id', artifactId)
      .is('superseded_at', null)
      .order('created_at', { ascending: false }),
  ])

  return {
    artifact: artifact as BusinessArtifactRow,
    observations: (observations ?? []) as BusinessArtifactObservationRow[],
    relations: (relations ?? []) as BusinessArtifactRelationRow[],
  }
}

/**
 * Deterministic resolution for "that image"/"remember this" immediately
 * following an artifact the SAME operator just sent — no session/active-work
 * state required, survives fresh conversations and restarts by construction
 * since it's a plain recency query over durable rows.
 */
export async function getMostRecentArtifactForOperator(params: {
  workspaceId: string
  operatorAllowlistId: number
  withinMs?: number
  modality?: ArtifactModality
}): Promise<BusinessArtifactRow | null> {
  const supabase = createServiceClient()
  let q = supabase
    .from('business_artifacts')
    .select('*')
    .eq('workspace_id', params.workspaceId)
    .eq('sender_operator_allowlist_id', params.operatorAllowlistId)
    .neq('retention_status', 'deleted')

  if (params.modality) q = q.eq('modality', params.modality)
  if (params.withinMs) {
    q = q.gte('received_at', new Date(Date.now() - params.withinMs).toISOString())
  }

  const { data } = await q.order('received_at', { ascending: false }).limit(1).maybeSingle()
  return (data as BusinessArtifactRow | null) ?? null
}
