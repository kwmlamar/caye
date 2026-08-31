import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createServiceClient()
  const itemsResult = await db
    .from('intelligence_items')
    .select('id,scope,domain,topic,canonical_claim,epistemic_type,status,confidence,relevance,novelty,materiality,observed_at,updated_at,valid_until,refresh_after')
    .in('scope', ['operator', 'global'])
    .is('workspace_id', null)
    .in('status', ['current', 'contested'])
    .order('materiality', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(200)

  if (itemsResult.error) return NextResponse.json({ error: 'Intelligence unavailable' }, { status: 503 })
  const items = itemsResult.data ?? []
  const ids = items.map((item) => item.id)
  if (!ids.length) return NextResponse.json({ items: [], total: 0 })

  const [relationsResult, revisionsResult] = await Promise.all([
    db.from('intelligence_relations')
      .select('id,from_item_id,to_item_id,relation_type,status,confidence,created_at')
      .eq('status', 'active')
      .or(`from_item_id.in.(${ids.join(',')}),to_item_id.in.(${ids.join(',')})`),
    db.from('intelligence_belief_revisions')
      .select('id,intelligence_item_id,prior_confidence,revised_confidence,rationale,evidence_role,created_at')
      .in('intelligence_item_id', ids)
      .order('created_at', { ascending: false }),
  ])

  if (relationsResult.error || revisionsResult.error) {
    return NextResponse.json({ error: 'Intelligence graph unavailable' }, { status: 503 })
  }

  const visible = new Set(ids)
  const relations = (relationsResult.data ?? []).filter((relation) => visible.has(relation.from_item_id) && visible.has(relation.to_item_id))
  const revisions = revisionsResult.data ?? []

  const enriched = items.map((item) => {
    const itemRelations = relations.filter((relation) => relation.from_item_id === item.id || relation.to_item_id === item.id)
    const itemRevisions = revisions.filter((revision) => revision.intelligence_item_id === item.id)
    return {
      ...item,
      relationCount: itemRelations.length,
      contradictionCount: itemRelations.filter((relation) => relation.relation_type === 'contradicts').length,
      revisionCount: itemRevisions.length,
      latestRevision: itemRevisions[0] ?? null,
    }
  })

  return NextResponse.json({ items: enriched, total: enriched.length })
}
