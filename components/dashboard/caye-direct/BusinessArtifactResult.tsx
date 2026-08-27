'use client'

import { useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'

type Artifact = {
  id: string
  filename: string | null
  modality: string
  mimeType: string | null
  receivedAt: string
  processingStatus: string
  url: string
}

/** Trusted result: only an artifact id crosses the chat boundary; this component obtains a short-lived signed URL after server-side workspace-authorization. Mirrors EngineeringArtifactResult.tsx. */
export function BusinessArtifactResult({ artifactId, workspaceId }: { artifactId: string; workspaceId: string }) {
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch(`/api/founder/business-artifacts/${artifactId}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json().catch(() => null)
      if (cancelled) return
      if (res.ok && json?.artifact) setArtifact(json.artifact)
      else setError(true)
    })()
    return () => { cancelled = true }
  }, [artifactId, workspaceId])

  if (error) return <div style={{ color: '#a1a1aa', fontSize: 12, padding: '6px 0' }}>That file isn&apos;t available right now.</div>
  if (!artifact) return <div style={{ color: '#a1a1aa', fontSize: 12, padding: '6px 0' }}>Loading attachment…</div>

  if (artifact.modality === 'image') {
    return (
      <a href={artifact.url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 8 }}>
        <img
          src={artifact.url}
          alt={artifact.filename ?? 'Attached image'}
          style={{ maxWidth: 320, maxHeight: 320, borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', display: 'block' }}
        />
      </a>
    )
  }

  // Document (and any other modality that reaches this component) — a
  // useful file card, never a raw storage path/URL in the DOM beyond this
  // one short-lived href.
  return (
    <a
      href={artifact.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, padding: '10px 12px',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, background: 'rgba(255,255,255,0.04)',
        maxWidth: 320, textDecoration: 'none', color: '#f4f4f5',
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#72cfd9" strokeWidth="1.8" style={{ flexShrink: 0 }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {artifact.filename ?? 'Attached file'}
        </div>
        <div style={{ fontSize: 10.5, color: '#8e8e96', marginTop: 1 }}>{artifact.mimeType ?? artifact.modality} · Open</div>
      </div>
    </a>
  )
}
