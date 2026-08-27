import 'server-only'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { checksum, cleanupStagedEngineeringFiles } from '../storage'
import { resolveMaterial } from './materials'
import { resolveGeometryRegion, type ArtifactSpecForRegions, type GeometryRegionName, type ResolvedRegion } from './geometry-regions'
import type { AnalysisConstraint, AnalysisLoad } from './spec'
import { CalculixGmshSolver } from './solver'

const ANALYSIS_BUCKET = 'engineering-analyses'
const ARTIFACT_BUCKET = 'engineering-artifacts'
const MAX_ANALYSIS_BYTES = 25 * 1024 * 1024
const MAX_FAILURE_REASON_CHARS = 1000
const REQUIRED_KINDS = ['solver_input', 'mesh', 'solver_output', 'result_summary'] as const
type FileKind = typeof REQUIRED_KINDS[number]
type StagedFile = { kind: FileKind; storage_path: string; media_type: string; byte_size: number; checksum: string }

export type SourceArtifact = { id: string; revision: number; name: string; parameters: Record<string, number> }

function pathFor(workspaceId: string, analysisId: string, filename: string) { return `${workspaceId}/${analysisId}/${filename}` }
function boundedFailureReason(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, MAX_FAILURE_REASON_CHARS) || 'Analysis failed'
}

class EngineeringAnalysisKnownUncommittedError extends Error {}
class EngineeringAnalysisFinalizationIndeterminateError extends Error {}

/** Loads the artifact row this analysis targets, scoped to the workspace. Never a foreign-workspace read. */
export async function resolveSourceArtifact(workspaceId: string, artifactId: string): Promise<SourceArtifact | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('engineering_artifacts').select('id, revision, name, parameters').eq('id', artifactId).eq('workspace_id', workspaceId).maybeSingle()
  if (error || !data) return null
  return { id: data.id, revision: data.revision, name: data.name, parameters: data.parameters as Record<string, number> }
}

/** The fixed operations vocabulary a resolved artifact implies (V1 has exactly one template) — mirrors revise-parametric-part.ts's own reconstruction of an EngineeringSpec from a DB row. */
export function artifactSpecForRegions(artifact: SourceArtifact): ArtifactSpecForRegions {
  const p = artifact.parameters
  return { operations: ['l_bracket', 'mounting_holes'], parameters: { width_mm: p.width_mm, height_mm: p.height_mm, depth_mm: p.depth_mm, thickness_mm: p.thickness_mm } }
}

async function downloadArtifactStepBytes(supabase: ReturnType<typeof createServiceClient>, artifactId: string): Promise<Buffer> {
  const { data: fileRow, error: fileError } = await supabase.from('engineering_artifact_files').select('storage_path').eq('artifact_id', artifactId).eq('kind', 'export_geometry').maybeSingle()
  if (fileError || !fileRow) throw new Error('Source artifact STEP export is missing')
  const { data: blob, error } = await supabase.storage.from(ARTIFACT_BUCKET).download(fileRow.storage_path)
  if (error || !blob) throw new Error(`Could not download source artifact geometry: ${error?.message ?? 'unknown error'}`)
  return Buffer.from(await blob.arrayBuffer())
}

async function markAnalysisJobFailed(supabase: ReturnType<typeof createServiceClient>, jobId: string, cause: unknown): Promise<void> {
  const { data, error } = await supabase.from('engineering_analysis_jobs').update({ status: 'failed', failed_at: new Date().toISOString(), failure_reason: boundedFailureReason(cause) }).eq('id', jobId).in('status', ['running', 'meshing', 'solving']).select('id').maybeSingle()
  if (error || !data) throw new Error(`Could not mark engineering analysis job failed: ${error?.message ?? 'job was not in a runnable state'}`)
}

async function reconcileAnalysisFinalization(
  supabase: ReturnType<typeof createServiceClient>,
  args: { jobId: string; workspaceId: string; analysisId: string },
): Promise<{ state: 'committed'; analysisId: string } | { state: 'uncommitted' } | { state: 'indeterminate'; reason: string }> {
  const [{ data: job, error: jobError }, { data: analysis, error: analysisError }] = await Promise.all([
    supabase.from('engineering_analysis_jobs').select('id, status').eq('id', args.jobId).eq('workspace_id', args.workspaceId).maybeSingle(),
    supabase.from('engineering_analyses').select('id, job_id, engineering_analysis_files(kind)').eq('id', args.analysisId).eq('workspace_id', args.workspaceId).maybeSingle(),
  ])
  if (jobError || analysisError) return { state: 'indeterminate', reason: `authoritative reconciliation query failed: ${jobError?.message ?? analysisError?.message ?? 'unknown error'}` }
  if (job?.status === 'completed' && analysis?.id === args.analysisId && analysis.job_id === args.jobId) {
    const files = (analysis.engineering_analysis_files ?? []) as Array<{ kind: FileKind }>
    const complete = files.length === REQUIRED_KINDS.length && REQUIRED_KINDS.every((kind) => files.some((file) => file.kind === kind))
    if (complete) return { state: 'committed', analysisId: analysis.id }
    return { state: 'indeterminate', reason: 'job is completed but the analysis file metadata is incomplete' }
  }
  if (job && job.status !== 'completed' && job.status !== 'failed' && !analysis) return { state: 'uncommitted' }
  return { state: 'indeterminate', reason: `unexpected authoritative state (job=${job?.status ?? 'missing'}, analysis=${analysis ? 'present' : 'missing'})` }
}

export type RunAnalysisArgs = {
  workspaceId: string
  threadId: string
  messageId: string
  sourceArtifact: SourceArtifact
  materialId: string
  constraints: AnalysisConstraint[]
  loads: AnalysisLoad[]
  previousAnalysisId?: string | null
}

/** Files stage under an unreferenced UUID; the final RPC makes all metadata discoverable atomically — same pattern as ../artifacts.ts. */
export async function runStaticStructuralAnalysis(args: RunAnalysisArgs) {
  const material = resolveMaterial(args.materialId)
  if (!material) throw new Error(`Unknown material "${args.materialId}"`)

  const regionNames = new Set<GeometryRegionName>([...args.constraints.map((c) => c.region), ...args.loads.map((l) => l.region)])
  const artifactSpec = artifactSpecForRegions(args.sourceArtifact)
  const regions: Record<string, ResolvedRegion> = {}
  for (const name of regionNames) {
    const region = resolveGeometryRegion(artifactSpec, name)
    if (!region) throw new Error(`Geometry region "${name}" is no longer resolvable on artifact revision ${args.sourceArtifact.revision}`)
    regions[name] = region
  }

  const supabase = createServiceClient()
  const { data: job, error: jobError } = await supabase
    .from('engineering_analysis_jobs')
    .insert({
      workspace_id: args.workspaceId,
      originating_thread_id: args.threadId,
      originating_message_id: args.messageId,
      status: 'running',
      source_artifact_id: args.sourceArtifact.id,
      analysis_type: 'linear_static',
      material_id: args.materialId,
      analysis_spec: { constraints: args.constraints, loads: args.loads },
      solver: 'calculix',
      provenance: { engine: 'gmsh+calculix', sandbox: 'vercel', schema_version: 1 },
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (jobError || !job) throw new Error(`Could not start engineering analysis job: ${jobError?.message ?? 'unknown error'}`)

  const analysisId = randomUUID()
  const uploadedPaths: string[] = []
  const storage = supabase.storage.from(ANALYSIS_BUCKET)
  try {
    const stepBytes = await downloadArtifactStepBytes(supabase, args.sourceArtifact.id)

    await supabase.from('engineering_analysis_jobs').update({ status: 'meshing' }).eq('id', job.id).eq('workspace_id', args.workspaceId).eq('status', 'running')

    const solver = new CalculixGmshSolver()
    const result = await solver.run({ stepBytes, material, constraints: args.constraints, loads: args.loads, regions })

    if (result.maxVonMisesMpa <= 0 || result.maxDisplacementMm <= 0) throw new Error('Solver produced non-physical results')

    const resultSummary = JSON.stringify({
      max_von_mises_mpa: result.maxVonMisesMpa,
      max_displacement_mm: result.maxDisplacementMm,
      factor_of_safety: material.yieldStrengthMpa != null ? material.yieldStrengthMpa / result.maxVonMisesMpa : null,
      mesh: result.mesh,
      units: { length: 'mm', force: 'N', stress: 'MPa' },
    })

    const inputs: Array<[FileKind, string, Buffer | string, string]> = [
      ['solver_input', 'analysis.inp', result.files.solverInput, 'text/plain'],
      ['mesh', 'mesh.inp', result.files.mesh, 'application/octet-stream'],
      ['solver_output', 'analysis.frd', result.files.solverOutput, 'application/octet-stream'],
      ['result_summary', 'results.json', resultSummary, 'application/json'],
    ]
    const files: StagedFile[] = []
    for (const [kind, filename, content, mediaType] of inputs) {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_ANALYSIS_BYTES) throw new Error(`Engineering analysis ${kind} output is empty or exceeds the size limit`)
      const storagePath = pathFor(args.workspaceId, analysisId, filename)
      const { error } = await storage.upload(storagePath, bytes, { contentType: mediaType, upsert: false })
      if (error) throw new Error(`Could not stage engineering analysis ${kind}: ${error.message}`)
      uploadedPaths.push(storagePath)
      files.push({ kind, storage_path: storagePath, media_type: mediaType, byte_size: bytes.byteLength, checksum: checksum(bytes) })
    }

    const materialSnapshot = { id: material.id, displayName: material.displayName, youngsModulusMpa: material.youngsModulusMpa, poissonRatio: material.poissonRatio, densityTonnePerMm3: material.densityTonnePerMm3, yieldStrengthMpa: material.yieldStrengthMpa, source: material.source }
    const resultsForRow = {
      max_von_mises_mpa: result.maxVonMisesMpa,
      max_displacement_mm: result.maxDisplacementMm,
      factor_of_safety: material.yieldStrengthMpa != null ? material.yieldStrengthMpa / result.maxVonMisesMpa : null,
      units: { length: 'mm', force: 'N', stress: 'MPa' },
      disclaimer: 'Simulation result based on modeled geometry, material properties, loads, constraints, mesh, and solver assumptions. Not structural certification.',
    }

    const finalizeArgs = {
      p_job_id: job.id, p_workspace_id: args.workspaceId, p_analysis_id: analysisId,
      p_source_artifact_id: args.sourceArtifact.id, p_source_artifact_revision: args.sourceArtifact.revision,
      p_material_id: material.id, p_material: materialSnapshot,
      p_constraints: args.constraints, p_loads: args.loads,
      p_mesh_metadata: result.mesh, p_results: resultsForRow,
      p_solver: result.solver, p_solver_version: result.solverVersion,
      p_provenance: { engine: 'gmsh+calculix', generated_at: new Date().toISOString() },
      p_previous_analysis_id: args.previousAnalysisId ?? null,
      p_files: files,
    }
    const { data: finalized, error: finalizeError } = await supabase.rpc('caye_finalize_engineering_analysis', finalizeArgs)
    const outRow = finalized?.[0] as { out_analysis_id?: string } | undefined
    if (!finalizeError && outRow?.out_analysis_id) return { analysisId: outRow.out_analysis_id, results: resultsForRow, mesh: result.mesh, material: materialSnapshot }

    const reconciliation = await reconcileAnalysisFinalization(supabase, { jobId: job.id, workspaceId: args.workspaceId, analysisId })
    if (reconciliation.state === 'committed') return { analysisId: reconciliation.analysisId, results: resultsForRow, mesh: result.mesh, material: materialSnapshot }
    if (reconciliation.state === 'indeterminate') throw new EngineeringAnalysisFinalizationIndeterminateError(`Engineering analysis finalization is indeterminate: ${reconciliation.reason}`, { cause: finalizeError ?? new Error('incomplete finalization result') })
    throw new EngineeringAnalysisKnownUncommittedError(`Could not finalize engineering analysis: ${finalizeError?.message ?? 'incomplete finalization result'}`)
  } catch (cause) {
    if (cause instanceof EngineeringAnalysisFinalizationIndeterminateError) throw cause
    let cleanupError: unknown
    try { await cleanupStagedEngineeringFiles(storage, uploadedPaths) } catch (error) { cleanupError = error }
    try { await markAnalysisJobFailed(supabase, job.id, cause) } catch (transitionError) { throw new Error(`Engineering analysis failed and failure state was not recorded: ${transitionError instanceof Error ? transitionError.message : String(transitionError)}`, { cause }) }
    if (cleanupError) throw new Error(`Engineering analysis failed; staged-file cleanup needs attention: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause })
    throw cause
  }
}

export type TrustedAnalysis = {
  id: string
  sourceArtifactId: string
  sourceArtifactRevision: number
  sourceArtifactName: string
  materialId: string
  material: { displayName: string; source: string }
  constraints: AnalysisConstraint[]
  loads: AnalysisLoad[]
  meshMetadata: { nodeCount: number; elementCount: number; elementType: string }
  results: { max_von_mises_mpa: number; max_displacement_mm: number; factor_of_safety: number | null; units: Record<string, string>; disclaimer: string }
  solver: string
  createdAt: string
}

/** Trusted result: only an analysis id crosses the chat boundary; the DB row already carries every normalized value the Rich Result needs — no Storage read required. */
export async function getTrustedAnalysis(workspaceId: string, analysisId: string): Promise<TrustedAnalysis | null> {
  const supabase = createServiceClient()
  const { data: analysis, error } = await supabase
    .from('engineering_analyses')
    .select('id, source_artifact_id, source_artifact_revision, material_id, material, constraints, loads, mesh_metadata, results, solver, created_at')
    .eq('id', analysisId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error || !analysis) return null
  const { data: artifact } = await supabase.from('engineering_artifacts').select('name').eq('id', analysis.source_artifact_id).eq('workspace_id', workspaceId).maybeSingle()
  const material = analysis.material as { displayName: string; source: string }
  return {
    id: analysis.id,
    sourceArtifactId: analysis.source_artifact_id,
    sourceArtifactRevision: analysis.source_artifact_revision,
    sourceArtifactName: artifact?.name ?? 'Unknown artifact',
    materialId: analysis.material_id,
    material: { displayName: material.displayName, source: material.source },
    constraints: analysis.constraints as AnalysisConstraint[],
    loads: analysis.loads as AnalysisLoad[],
    meshMetadata: analysis.mesh_metadata as TrustedAnalysis['meshMetadata'],
    results: analysis.results as TrustedAnalysis['results'],
    solver: analysis.solver,
    createdAt: analysis.created_at,
  }
}

/** Loads a previously persisted analysis's material/constraints/loads for reuse against a (possibly newer) artifact revision. Never mutates the prior row. */
export async function loadAnalysisForRerun(workspaceId: string, previousAnalysisId: string): Promise<{ materialId: string; constraints: AnalysisConstraint[]; loads: AnalysisLoad[] } | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('engineering_analyses').select('material_id, constraints, loads').eq('id', previousAnalysisId).eq('workspace_id', workspaceId).maybeSingle()
  if (error || !data) return null
  return { materialId: data.material_id, constraints: data.constraints as AnalysisConstraint[], loads: data.loads as AnalysisLoad[] }
}
