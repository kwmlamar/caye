import 'server-only'
import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import type { EngineeringSpec } from './spec'
import { generateCadInSandbox } from './runtime'

const BUCKET = 'engineering-artifacts'

type ArtifactRow = { id: string; workspace_id: string; revision: number; name: string; dimensions: { bounds_mm?: Record<string, number> }; parameters: EngineeringSpec['parameters']; assumptions: string[]; parent_artifact_id: string | null }

function checksum(content: Buffer | string) { return createHash('sha256').update(content).digest('hex') }
function pathFor(workspaceId: string, artifactId: string, revision: number, filename: string) {
  return `${workspaceId}/${artifactId}/r${revision}/${filename}`
}

export async function createEngineeringArtifact(args: { workspaceId: string; threadId: string; messageId: string; spec: EngineeringSpec; parentArtifactId?: string | null; taskType: 'create_parametric_part' | 'revise_parametric_part' }) {
  const supabase = createServiceClient()
  const { data: job, error: jobError } = await supabase.from('engineering_jobs').insert({
    workspace_id: args.workspaceId, originating_thread_id: args.threadId, originating_message_id: args.messageId,
    status: 'running', task_type: args.taskType, parameters: args.spec.parameters, assumptions: args.spec.assumptions,
    runtime: 'cadquery', provenance: { engine: 'cadquery', sandbox: 'vercel', schema_version: 1 }, started_at: new Date().toISOString(),
  }).select('id').single()
  if (jobError || !job) throw new Error(`Could not start engineering job: ${jobError?.message ?? 'unknown error'}`)
  try {
    let parent: ArtifactRow | null = null
    if (args.parentArtifactId) {
      const { data } = await supabase.from('engineering_artifacts').select('id, workspace_id, revision, name, dimensions, parameters, assumptions, parent_artifact_id').eq('id', args.parentArtifactId).eq('workspace_id', args.workspaceId).maybeSingle()
      parent = data as ArtifactRow | null
      if (!parent) throw new Error('The artifact to revise was not found in this workspace')
    }
    const generated = await generateCadInSandbox(args.spec)
    const revision = (parent?.revision ?? 0) + 1
    const { data: artifact, error: artifactError } = await supabase.from('engineering_artifacts').insert({
      workspace_id: args.workspaceId, job_id: job.id, parent_artifact_id: parent?.id ?? null, revision, name: args.spec.name,
      parameters: args.spec.parameters, assumptions: args.spec.assumptions, dimensions: generated.metadata.bounds_mm,
      calculation_metadata: { volume_mm3: generated.metadata.volume_mm3, disclaimer: 'Geometry-derived properties only. This is not structural verification or a safe-load claim.' },
      provenance: { engine: 'cadquery', generated_at: new Date().toISOString() },
    }).select('id, revision, name').single()
    if (artifactError || !artifact) throw new Error(`Could not create engineering artifact: ${artifactError?.message ?? 'unknown error'}`)
    const uploads = [
      ['source', 'part.py', generated.source, 'text/x-python'], ['preview_geometry', 'part.stl', generated.stl, 'application/sla'],
      ['export_geometry', 'part.step', generated.step, 'model/step'], ['metadata', 'metadata.json', JSON.stringify(generated.metadata), 'application/json'],
    ] as const
    for (const [kind, filename, content, mediaType] of uploads) {
      const storagePath = pathFor(args.workspaceId, artifact.id, artifact.revision, filename)
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
      const { error } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, { contentType: mediaType, upsert: false })
      if (error) throw new Error(`Could not persist engineering artifact file: ${error.message}`)
      const { error: fileError } = await supabase.from('engineering_artifact_files').insert({ artifact_id: artifact.id, kind, storage_path: storagePath, media_type: mediaType, byte_size: bytes.byteLength, checksum: checksum(bytes) })
      if (fileError) throw new Error(`Could not record engineering artifact file: ${fileError.message}`)
    }
    await supabase.from('engineering_jobs').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', job.id)
    return { artifactId: artifact.id as string, revision: artifact.revision as number, name: artifact.name as string }
  } catch (error) {
    await supabase.from('engineering_jobs').update({ status: 'failed', failed_at: new Date().toISOString(), failure_reason: 'Generation failed' }).eq('id', job.id)
    throw error
  }
}

export async function getTrustedArtifact(workspaceId: string, artifactId: string) {
  const supabase = createServiceClient()
  const { data: artifact, error } = await supabase.from('engineering_artifacts').select('id, revision, name, dimensions, calculation_metadata, parent_artifact_id, engineering_artifact_files(kind, storage_path, media_type)').eq('id', artifactId).eq('workspace_id', workspaceId).maybeSingle()
  if (error || !artifact) return null
  const files = (artifact.engineering_artifact_files ?? []) as Array<{ kind: string; storage_path: string; media_type: string }>
  const preview = files.find((file) => file.kind === 'preview_geometry')
  if (!preview) return null
  const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(preview.storage_path, 60 * 10)
  if (!signed?.signedUrl) return null
  return { id: artifact.id, revision: artifact.revision, name: artifact.name, dimensions: artifact.dimensions, calculationMetadata: artifact.calculation_metadata, parentArtifactId: artifact.parent_artifact_id, preview: { url: signed.signedUrl, mediaType: preview.media_type } }
}
