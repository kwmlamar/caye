'use client'
import type { RichResult, RichResultBlock } from '@/lib/caye-direct-rich-results'
import { EngineeringArtifactResult } from './EngineeringArtifactResult'
import { EngineeringAnalysisResult } from './EngineeringAnalysisResult'
import { BusinessArtifactResult } from './BusinessArtifactResult'
import { PropertySpatialResult } from './PropertySpatialResult'
import { EngineeringProjectResult } from './EngineeringProjectResult'

function Reference({ type, id, resolved }: { type: string; id: string; resolved?: Record<string, string> }) {
  return <div style={{ borderLeft: '2px solid #4EBECE', padding: '7px 10px', background: 'rgba(78,190,206,.07)', borderRadius: 5, fontSize: 12 }}><span style={{ color: '#8e8e96' }}>{type}</span> {resolved?.title ?? id}{resolved?.status ? ` · ${resolved.status}` : ''}</div>
}
function Block({ block, resolved, workspaceId }: { block: RichResultBlock; resolved?: Record<string, string>; workspaceId?: string }) {
  if (block.type === 'engineering_artifact') return workspaceId ? <EngineeringArtifactResult artifactId={block.artifactId} workspaceId={workspaceId} /> : null
  if (block.type === 'engineering_analysis') return workspaceId ? <EngineeringAnalysisResult analysisId={block.analysisId} workspaceId={workspaceId} /> : null
  if (block.type === 'business_artifact') return workspaceId ? <BusinessArtifactResult artifactId={block.artifactId} workspaceId={workspaceId} /> : null
  if (block.type === 'property_snapshot') return workspaceId ? <PropertySpatialResult propertyId={block.propertyId} workspaceId={workspaceId} /> : null
  if (block.type === 'engineering_project') return <EngineeringProjectResult projectId={block.projectId} />
  if (block.type === 'metric') return <div style={{ padding: 10, background: 'rgba(255,255,255,.05)', borderRadius: 8 }}><div style={{ color: '#8e8e96', fontSize: 10 }}>{block.label}</div><div style={{ fontSize: 20, fontWeight: 600 }}>{block.value}</div>{block.detail && <div style={{ color: '#a1a1aa', fontSize: 11 }}>{block.detail}</div>}</div>
  if (block.type === 'table') return <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}><thead><tr>{block.columns.map(c => <th key={c} style={{ textAlign: 'left', color: '#a1a1aa', padding: 6 }}>{c}</th>)}</tr></thead><tbody>{block.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} style={{ borderTop: '1px solid rgba(255,255,255,.08)', padding: 6 }}>{v}</td>)}</tr>)}</tbody></table></div>
  if (block.type === 'code' || block.type === 'code_diff') return <pre style={{ margin: 0, overflowX: 'auto', padding: 10, background: '#0b0b0d', borderRadius: 8, fontSize: 11 }}>{block.type === 'code' ? block.code : `- ${block.before}\n+ ${block.after}`}</pre>
  if (block.type === 'goal_reference' || block.type === 'work_reference') return <Reference type={block.type === 'goal_reference' ? 'Goal' : 'Work'} id={block.id} resolved={block.resolved ?? resolved} />
  return <div style={{ padding: '7px 10px', background: 'rgba(255,255,255,.04)', borderRadius: 6, fontSize: 12 }}><span style={{ color: '#8e8e96' }}>Artifact</span> {block.name}{block.mimeType ? ` · ${block.mimeType}` : ''}</div>
}
export function RichResultRenderer({ result, workspaceId }: { result: RichResult; workspaceId?: string }) { return <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>{result.blocks.map((b, i) => <Block key={i} block={b} workspaceId={workspaceId} />)}</div> }
