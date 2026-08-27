import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * Minimal thenable fake covering annotateArtifact's exact chains:
 *   artifact lookup:      .from('business_artifacts').select('id').eq().eq().maybeSingle()
 *   prior annotation:     .from('business_artifact_observations').select('id').eq().eq().is().maybeSingle()
 *   insert observation:   .from('business_artifact_observations').insert(payload).select('id').single()
 *   supersede prior obs:  .from('business_artifact_observations').update(payload).eq('id', id)
 *   prior relation:       .from('business_artifact_relations').select('id').eq()x3.eq().is().maybeSingle()
 *   insert relation:      .from('business_artifact_relations').insert(payload).select('id').single()
 *   supersede prior rel:  .from('business_artifact_relations').update(payload).eq('id', id)
 */
function fakeSupabase(opts: {
  artifactExists?: boolean
  priorAnnotationId?: string | null
  priorRelationId?: string | null
}) {
  const updateCalls: Array<{ table: string; payload: unknown; id: unknown }> = []
  const insertCalls: Array<{ table: string; payload: unknown }> = []
  let obsSeq = 0
  let relSeq = 0

  const from = vi.fn((table: string) => ({
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {}
      chain.eq = vi.fn(() => chain)
      chain.is = vi.fn(() => chain)
      chain.maybeSingle = vi.fn(() => {
        if (table === 'business_artifacts') {
          return Promise.resolve({ data: opts.artifactExists === false ? null : { id: 'artifact-1' } })
        }
        if (table === 'business_artifact_observations') {
          return Promise.resolve({ data: opts.priorAnnotationId ? { id: opts.priorAnnotationId } : null })
        }
        return Promise.resolve({ data: opts.priorRelationId ? { id: opts.priorRelationId } : null })
      })
      return chain
    }),
    insert: vi.fn((payload: unknown) => {
      insertCalls.push({ table, payload })
      const id = table === 'business_artifact_observations' ? `obs-${++obsSeq}` : `rel-${++relSeq}`
      return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id }, error: null })) })) }
    }),
    update: vi.fn((payload: unknown) => ({
      eq: vi.fn((_col: string, id: unknown) => {
        updateCalls.push({ table, payload, id })
        return Promise.resolve({ error: null })
      }),
    })),
  }))

  return { client: { from }, insertCalls, updateCalls }
}

let currentClient: ReturnType<typeof fakeSupabase>['client']
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => currentClient }))

import { annotateArtifact } from './relations'

describe('annotateArtifact — operator correction supersedes prior understanding (#87 acceptance test 4)', () => {
  it('rejects annotating an artifact that does not exist in this workspace', async () => {
    const fake = fakeSupabase({ artifactExists: false })
    currentClient = fake.client
    const result = await annotateArtifact({
      workspaceId: 'ws-1',
      artifactId: 'nope',
      operatorAllowlistId: 7,
      meaning: 'test',
    })
    expect(result.ok).toBe(false)
  })

  it('writes a fresh operator_confirmed observation with no prior annotation to supersede', async () => {
    const fake = fakeSupabase({ artifactExists: true, priorAnnotationId: null })
    currentClient = fake.client

    const result = await annotateArtifact({
      workspaceId: 'ws-1',
      artifactId: 'artifact-1',
      operatorAllowlistId: 7,
      meaning: 'The Casino tram stop, where all cruise guests meet Max for pickup.',
    })

    expect(result.ok).toBe(true)
    const obsInsert = fake.insertCalls.find((c) => c.table === 'business_artifact_observations')
    expect(obsInsert?.payload).toMatchObject({
      observation_type: 'operator_annotation',
      provenance_status: 'operator_confirmed',
      derived_by: 'operator:7',
    })
    // Nothing to supersede on a first annotation.
    expect(fake.updateCalls).toHaveLength(0)
  })

  it('supersedes the PRIOR annotation rather than mutating or deleting it — old guess stays in history', async () => {
    const fake = fakeSupabase({ artifactExists: true, priorAnnotationId: 'obs-old-guess' })
    currentClient = fake.client

    const result = await annotateArtifact({
      workspaceId: 'ws-1',
      artifactId: 'artifact-1',
      operatorAllowlistId: 7,
      meaning: 'No — that is the Casino tram stop, not the Heritage Tour pickup.',
    })

    expect(result.ok).toBe(true)
    const supersedeCall = fake.updateCalls.find((c) => c.table === 'business_artifact_observations' && c.id === 'obs-old-guess')
    expect(supersedeCall).toBeTruthy()
    expect(supersedeCall?.payload).toMatchObject({ superseded_by: expect.any(String) })
    // The old row is superseded, never deleted — no delete call exists anywhere in this module.
  })

  it('marks a corrected relation as operator_corrected (not operator_confirmed) when one already existed', async () => {
    const fake = fakeSupabase({ artifactExists: true, priorRelationId: 'rel-old' })
    currentClient = fake.client

    await annotateArtifact({
      workspaceId: 'ws-1',
      artifactId: 'artifact-1',
      operatorAllowlistId: 7,
      meaning: 'Casino tram stop.',
      targetEntityType: 'contact',
      targetEntityId: 'contact-max',
    })

    const relInsert = fake.insertCalls.find((c) => c.table === 'business_artifact_relations')
    expect(relInsert?.payload).toMatchObject({ provenance: 'operator_corrected', corrected_from_relation_id: 'rel-old' })
  })
})
