import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import type { EngineeringSpec } from './spec'
import { generateCadInSandbox } from './runtime'

const BUCKET = 'engineering-artifacts'
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
const REQUIRED_KINDS = ['source', 'preview_geometry', 'export_geometry', 'metadata'] as const
type FileKind = typeof REQUIRED_KINDS[number]
type ArtifactRow = { id: string; lineage_id: string; revision: number; name: string; parameters: EngineeringSpec['parameters']; assumptions: string[] }
type StagedFile = { kind: FileKind; storage_path: string; media_type: string; byte_size: number; checksum: string }
type FinalizedArtifact = { artifactId: string; revision: number; name: string }

function checksum(content: Buffer | string) { return createHash('sha256').update(content).digest('hex') }
function pathFor(workspaceId: string, lineageId: string, artifactId: string, filename: string) { return `${workspaceId}/${lineageId}/${artifactId}/${filename}` }

export async function cleanupStagedEngineeringFiles(storage: { remove(paths: string[]): PromiseLike<{ error: { message: string } | null }> }, paths: readonly string[]): Promise<void> {
  if (!paths.length) return
  const { error } = await storage.remove([...new Set(paths)])
  if (error && !/not found|does not exist/i.test(error.message)) throw new Error(`Could not clean staged engineering files: ${error.message}`)
}

async function markJobFailed(supabase: ReturnType<typeof createServiceClient>, jobId: string): Promise<void> {
  const { data, error } = await supabase.from('engineering_jobs').update({ status: 'failed', failed_at: new Date().toISOString(), failure_reason: 'Generation failed' }).eq('id', jobId).eq('status', 'running').select('id').maybeSingle()
  if (error || !data) throw new Error(`Could not mark engineering job failed: ${error?.message ?? 'job was not running'}`)
}

async function reconcileFinalization(
  supabase: ReturnType<typeof createServiceClient>,
  args: { jobId: string; workspaceId: string; artifactId: string; name: string },
): Promise<{ state: 'committed'; artifact: FinalizedArtifact } | { state: 'uncommitted' } | { state: 'indeterminate'; reason: string }> {
  const [{ data: job, error: jobError }, { data: artifact, error: artifactError }] = await Promise.all([
    supabase.from('engineering_jobs').select('id, status').eq('id', args.jobId).eq('workspace_id', args.workspaceId).maybeSingle(),
    supabase.from('engineering_artifacts').select('id, job_id, revision, name, engineering_artifact_files(kind)').eq('id', args.artifactId).eq('workspace_id', args.workspaceId).maybeSingle(),
  ])
  if (jobError || artifactError) {
    return { state: 'indeterminate', reason: `authoritative reconciliation query failed: ${jobError?.message ?? artifactError?.message ?? 'unknown error'}` }
  }

  if (job?.status === 'completed' && artifact?.id === args.artifactId && artifact.job_id === args.jobId) {
    const files = (artifact.engineering_artifact_files ?? []) as Array<{ kind: FileKind }>
    const complete = files.length === REQUIRED_KINDS.length && REQUIRED_KINDS.every((kind) => files.some((file) => file.kind === kind))
    if (complete && Number.isInteger(artifact.revision)) {
      return { state: 'committed', artifact: { artifactId: artifact.id, revision: artifact.revision, name: artifact.name ?? args.name } }
    }
    return { state: 'indeterminate', reason: 'job is completed but the artifact metadata is incomplete' }
  }

  if (job?.status === 'running' && !artifact) return { state: 'uncommitted' }

  return { state: 'indeterminate', reason: `unexpected authoritative state (job=${job?.status ?? 'missing'}, artifact=${artifact ? 'present' : 'missing'})` }
}

/** Files stage under an unreferenced UUID; the final RPC makes all metadata discoverable atomically. */
export async function createEngineeringArtifact(args: { workspaceId: string; threadId: string; messageId: string; spec: EngineeringSpec; parentArtifactId?: string | null; taskType: 'create_parametric_part' | 'revise_parametric_part' }) {
  const supabase = createServiceClient()
  const { data: job, error: jobError } = await supabase.from('engineering_jobs').insert({
    workspace_id: args.workspaceId, originating_thread_id: args.threadId, originating_message_id: args.messageId, status: 'running', task_type: args.taskType,
    parameters: args.spec.parameters, assumptions: args.spec.assumptions, runtime: 'cadquery', provenance: { engine: 'cadquery', sandbox: 'vercel', schema_version: 1 }, started_at: new Date().toISOString(),
  }).select('id').single()
  if (jobError || !job) throw new Error(`Could not start engineering job: ${jobError?.message ?? 'unknown error'}`)
  const artifactId = randomUUID()
  const uploadedPaths: string[] = []
  const storage = supabase.storage.from(BUCKET)
  try {
    let parent: ArtifactRow | null = null
    if (args.parentArtifactId) {
      const { data, error } = await supabase.from('engineering_artifacts').select('id, lineage_id, revision, name, parameters, assumptions').eq('id', args.parentArtifactId).eq('workspace_id', args.workspaceId).maybeSingle()
      if (error) throw new Error(`Could not load engineering revision parent: ${error.message}`)
      parent = data as ArtifactRow | null
      if (!parent) throw new Error('The artifact to revise was not found in this workspace')
    }
    const lineageId = parent?.lineage_id ?? randomUUID()
    const generated = await generateCadInSandbox(args.spec)
    const inputs: Array<[FileKind, string, Buffer | string, string]> = [
      ['source', 'part.py', generated.source, 'text/x-python'], ['preview_geometry', 'part.stl', generated.stl, 'application/sla'],
      ['export_geometry', 'part.step', generated.step, 'model/step'], ['metadata', 'metadata.json', JSON.stringify(generated.metadata), 'application/json'],
    ]
    const files: StagedFile[] = []
    for (const [kind, filename, content, mediaType] of inputs) {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error(`Engineering ${kind} output is empty or exceeds the size limit`)
      const storagePath = pathFor(args.workspaceId, lineageId, artifactId, filename)
      const { error } = await storage.upload(storagePath, bytes, { contentType: mediaType, upsert: false })
      if (error) throw new Error(`Could not stage engineering ${kind}: ${error.message}`)
      uploadedPaths.push(storagePath)
      files.push({ kind, storage_path: storagePath, media_type: mediaType, byte_size: bytes.byteLength, checksum: checksum(bytes) })
    }

    const finalizeArgs = {
      p_job_id: job.id, p_workspace_id: args.workspaceId, p_artifact_id: artifactId, p_lineage_id: lineageId, p_parent_artifact_id: parent?.id ?? null,
      p_name: args.spec.name, p_parameters: args.spec.parameters, p_assumptions: args.spec.assumptions, p_dimensions: generated.metadata.bounds_mm,
      p_calculation_metadata: { volume_mm3: generated.metadata.volume_mm3, disclaimer: 'Geometry-derived properties only. This is not structural verification or a safe-load claim.' },
      p_provenance: { engine: 'cadquery', generated_at: new Date().toISOString() }, p_files: files,
    }
    const { data: finalized, error: finalizeError } = await supabase.rpc('caye_finalize_engineering_artifact', finalizeArgs)
    const result = finalized?.[0] as { artifact_id?: string; revision?: number } | undefined
    if (!finalizeError && result?.artifact_id && Number.isInteger(result.revision)) {
      return { artifactId: result.artifact_id, revision: result.revision, name: args.spec.name }
    }

    // An RPC transport error is not proof that the transaction failed. Reconcile
    // against durable state before performing destructive compensation.
    const reconciliation = await reconcileFinalization(supabase, { jobId: job.id, workspaceId: args.workspaceId, artifactId, name: args.spec.name })
    if (reconciliation.state === 'committed') return reconciliation.artifact
    if (reconciliation.state === 'indeterminate') {
      throw new EngineeringFinalizationIndeterminateError(`Engineering finalization is indeterminate: ${reconciliation.reason}`, { cause: finalizeError ?? new Error('incomplete finalization result') })
    }
    throw new EngineeringKnownUncommittedError(`Could not finalize engineering artifact: ${finalizeError?.message ?? 'incomplete finalization result'}`)
  } catch (cause) {
    // Never delete staged objects if a commit may have happened. That could turn a
    // valid completed artifact into a database record pointing at missing files.
    if (cause instanceof EngineeringFinalizationIndeterminateError) throw cause

    let cleanupError: unknown
    try { await cleanupStagedEngineeringFiles(storage, uploadedPaths) } catch (error) { cleanupError = error }
    try { await markJobFailed(supabase, job.id) } catch (transitionError) { throw new Error(`Engineering generation failed and failure state was not recorded: ${transitionError instanceof Error ? transitionError.message : String(transitionError)}`, { cause }) }
    if (cleanupError) throw new Error(`Engineering generation failed; staged-file cleanup needs attention: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause })
    throw cause
  }
}

class EngineeringKnownUncommittedError extends Error {}
class EngineeringFinalizationIndeterminateError extends Error {}

export async function getTrustedArtifact(workspaceId: string, artifactId: string) {
  const supabase = createServiceClient()
  const { data: artifact, error } = await supabase.from('engineering_artifacts').select('id, revision, name, dimensions, calculation_metadata, parent_artifact_id, engineering_artifact_files(kind, storage_path, media_type)').eq('id', artifactId).eq('workspace_id', workspaceId).maybeSingle()
  if (error || !artifact) return null
  const files = (artifact.engineering_artifact_files ?? []) as Array<{ kind: FileKind; storage_path: string; media_type: string }>
  if (files.length !== REQUIRED_KINDS.length || REQUIRED_KINDS.some((kind) => !files.some((file) => file.kind === kind))) return null
  const preview = files.find((file) => file.kind === 'preview_geometry')!
  const { data: signed, error: signedError } = await supabase.storage.from(BUCKET).createSignedUrl(preview.storage_path, 60 * 10)
  if (signedError || !signed?.signedUrl) return null
  return { id: artifact.id, revision: artifact.revision, name: artifact.name, dimensions: artifact.dimensions, calculationMetadata: artifact.calculation_metadata, parentArtifactId: artifact.parent_artifact_id, preview: { url: signed.signedUrl, mediaType: preview.media_type } }
}
