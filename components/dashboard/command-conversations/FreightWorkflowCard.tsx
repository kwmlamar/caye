'use client'

import { useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { AQUA, TEXT, TEXT_QUIET } from '@/components/dashboard/surface'

type Candidate = { evidence: { id: string; vendor: string | null; purchaseDate: string | null; total: number | null; currency: string | null; lines: unknown[] }; confidence: string }
type State = { isFreightDocumentRequest?: boolean; status?: 'MATCH_FOUND' | 'AMBIGUOUS' | 'NO_MATCH' | 'READY_FOR_APPROVAL' | 'SENT'; request?: { dockReceiptNumber: string | null; freightProvider: string | null }; candidates?: Candidate[]; selectedEvidenceId?: string | null; generatedArtifactId?: string | null; reply?: string | null; error?: string }

export function FreightWorkflowCard({ workspaceId, conversationId, onPrepared }: { workspaceId: string; conversationId: string; onPrepared: (reply: string) => void }) {
  const [state, setState] = useState<State | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  async function call(method: 'GET' | 'POST', action?: string, evidenceId?: string) {
    const { session } = await getSession(); if (!session) return
    setBusy(true); setError(null)
    try {
      const params = new URLSearchParams({ workspaceId, conversationId })
      const res = await fetch(`/api/founder/freight-workflow?${params}`, { method, headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ action, evidenceId }) } : {}) })
      const json = await res.json() as State
      if (!res.ok) throw new Error(json.error ?? 'Freight workflow failed')
      setState(json); if (json.reply) onPrepared(json.reply)
    } catch (e) { setError(e instanceof Error ? e.message : 'Freight workflow failed') } finally { setBusy(false) }
  }
  useEffect(() => { setState(null); void call('GET') /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId, conversationId])
  async function openArtifact(id: string) {
    const { session } = await getSession(); if (!session) return
    const params = new URLSearchParams({ workspaceId, conversationId, artifact: '1' })
    const res = await fetch(`/api/founder/freight-workflow?${params}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
    const json = await res.json() as { artifact?: { url?: string }; error?: string }
    if (json.artifact?.url) window.open(json.artifact.url, '_blank', 'noopener,noreferrer')
    else setError(json.error ?? 'Could not open document')
  }
  if (!state?.isFreightDocumentRequest) return null
  const selected = state.candidates?.find(c => c.evidence.id === state.selectedEvidenceId) ?? state.candidates?.[0]
  const buttonStyle = { border: '1px solid rgba(78,190,206,.45)', borderRadius: 999, padding: '6px 11px', color: '#b9f4fb', background: 'rgba(78,190,206,.12)', fontSize: 11, fontWeight: 700, cursor: busy ? 'default' : 'pointer' } as const
  return <div style={{ margin: '0 18px 10px', padding: '12px 14px', border: '1px solid rgba(78,190,206,.25)', borderRadius: 14, background: 'rgba(78,190,206,.06)', color: TEXT }}>
    <div style={{ color: AQUA, fontSize: 10, fontWeight: 800, letterSpacing: '.1em' }}>{state.status === 'AMBIGUOUS' ? 'CHOOSE A RECEIPT' : state.status === 'NO_MATCH' ? 'NO TRUSTED MATCH' : state.status === 'SENT' ? 'SENT' : 'FREIGHT DOCUMENT'}</div>
    <div style={{ marginTop: 5, fontSize: 13, fontWeight: 700 }}>{state.request?.freightProvider ?? 'Freight provider'} needs a document for Dock Receipt {state.request?.dockReceiptNumber ?? 'UNKNOWN'}.</div>
    {state.status === 'NO_MATCH' && <div style={{ marginTop: 5, color: TEXT_QUIET, fontSize: 12 }}>I searched connected purchase evidence but could not find a receipt I trust.</div>}
    {selected && <div style={{ marginTop: 7, color: TEXT_QUIET, fontSize: 12 }}>{selected.evidence.vendor ?? 'Unknown vendor'} · {selected.evidence.purchaseDate ?? 'Unknown date'} · {selected.evidence.total === null ? 'Unknown total' : `${selected.evidence.currency ?? ''} ${selected.evidence.total.toFixed(2)}`} · {selected.evidence.lines.length} items</div>}
    {error && <div style={{ color: '#fb7185', fontSize: 11, marginTop: 6 }}>{error}</div>}
    <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
      {(state.status === 'MATCH_FOUND' || state.status === 'AMBIGUOUS') && state.candidates?.slice(0, state.status === 'AMBIGUOUS' ? 5 : 1).map(c => <button key={c.evidence.id} disabled={busy} style={buttonStyle} onClick={() => call('POST', 'generate', c.evidence.id)}>{state.status === 'AMBIGUOUS' ? `Use ${c.evidence.vendor ?? 'this receipt'}` : 'Review document'}</button>)}
      {state.generatedArtifactId && <button style={buttonStyle} onClick={() => openArtifact(state.generatedArtifactId!)}>Open PDF</button>}
      {state.status === 'READY_FOR_APPROVAL' && <button disabled={busy} style={buttonStyle} onClick={() => call('POST', 'approve_send')}>Attach &amp; send</button>}
    </div>
  </div>
}
