'use client'

import { AQUA, EMERALD, GOLD, ROSE, TEXT, TEXT_MUTED, TEXT_QUIET } from '../surface'

export type DirectionRecommendation = {
  id: string
  fingerprint: string
  status: string
  title: string
  action: string
  why: string
  affectedGoal: string
  confidence: number
  expectedImpact: string
  urgency: string
  risk: string
  reversibility: string
  authority: { principalType: string | null; principalRef: string | null; resolvedBy: string | null; label: string }
  updatedAt: string
  evidence: Array<{ statement: string; confidence: number | null; sourceQuality: string | null; status: string }>
  decision: { id: string; state: 'pending' | 'approved' | 'rejected' | 'deferred' | 'stale'; canRespond: boolean; stale: boolean; requestedAt: string | null; expiresAt: string | null; decidedAt: string | null } | null
  executionState: string | null
  authorityDisposition: string | null
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function Detail({ label, value }: { label: string; value: string }) {
  return <span style={{ whiteSpace: 'nowrap' }}><span style={{ color: TEXT_QUIET }}>{label}</span> <span style={{ color: TEXT_MUTED }}>{value}</span></span>
}

export default function RecommendationCard({
  item,
  mode,
  busy,
  error,
  onDecision,
}: {
  item: DirectionRecommendation
  mode: 'working' | 'decision' | 'consider'
  busy?: boolean
  error?: string | null
  onDecision?: (item: DirectionRecommendation, action: 'approve' | 'reject' | 'defer') => void
}) {
  const accent = mode === 'working' ? EMERALD : mode === 'decision' ? ROSE : GOLD
  const eyebrow = item.decision?.stale
    ? 'RECOMMENDATION UPDATED'
    : item.decision?.state === 'approved'
      ? 'DECISION · APPROVED'
      : item.decision?.state === 'rejected'
        ? 'DECISION · REJECTED'
        : item.decision?.state === 'deferred'
          ? 'DEFERRED'
          : mode === 'working'
            ? 'ACTING ON RECOMMENDATION'
            : mode === 'decision'
              ? 'RECOMMENDATION'
              : 'WORTH CONSIDERING'

  return <div style={{ padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.045)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
      <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: accent, boxShadow: `0 0 6px ${accent}66` }} />
      <span style={{ fontSize: 9, fontWeight: 750, letterSpacing: '0.06em', color: accent }}>{eyebrow}</span>
      {item.urgency !== 'low' && <span style={{ marginLeft: 'auto', fontSize: 9, color: TEXT_QUIET }}>{item.urgency}</span>}
    </div>

    <div style={{ fontSize: 12.5, lineHeight: 1.45, fontWeight: 620, color: TEXT }}>{item.action}</div>
    <div style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.5, color: TEXT_MUTED }}>{item.why}</div>

    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 8, fontSize: 9.5, lineHeight: 1.45 }}>
      <Detail label="Goal" value={item.affectedGoal} />
      <Detail label="Confidence" value={pct(item.confidence)} />
      <Detail label="Impact" value={item.expectedImpact} />
      <Detail label="Risk" value={item.risk} />
      <Detail label="Reversible" value={item.reversibility} />
      <Detail label="Authority" value={item.authority.label} />
    </div>

    {mode === 'working' && item.authorityDisposition && <div style={{ marginTop: 6, fontSize: 9.5, color: EMERALD }}>Authority: {item.authorityDisposition.replace(/_/g, ' ')}</div>}
    {item.decision?.stale && <div style={{ marginTop: 7, fontSize: 9.5, lineHeight: 1.45, color: GOLD }}>{item.decision.canRespond ? 'A prior decision belongs to an older recommendation fingerprint. These controls apply only to the current version.' : 'A prior decision belongs to an older recommendation fingerprint. No stale approval is being reused.'}</div>}

    {item.evidence.length > 0 && <details style={{ marginTop: 7 }}>
      <summary style={{ width: 'fit-content', cursor: 'pointer', fontSize: 9.5, color: AQUA }}>Evidence · {item.evidence.length}</summary>
      <div style={{ marginTop: 6, paddingLeft: 11, borderLeft: '1px solid rgba(255,255,255,0.08)' }}>
        {item.evidence.map((evidence, index) => <div key={`${item.id}-evidence-${index}`} style={{ padding: '4px 0', fontSize: 9.5, lineHeight: 1.5, color: TEXT_MUTED }}>
          {evidence.statement}
          <span style={{ color: TEXT_QUIET }}> · {evidence.confidence == null ? 'confidence unknown' : pct(evidence.confidence)}{evidence.sourceQuality ? ` · ${evidence.sourceQuality.replace(/_/g, ' ')}` : ''}{evidence.status === 'contested' ? ' · contested' : ''}</span>
        </div>)}
      </div>
    </details>}

    {mode === 'decision' && item.decision?.canRespond && onDecision && <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10 }}>
      {(['approve', 'reject', 'defer'] as const).map((action) => <button
        key={action}
        type="button"
        disabled={busy}
        onClick={() => onDecision(item, action)}
        style={{
          border: `1px solid ${action === 'approve' ? `${EMERALD}55` : action === 'reject' ? `${ROSE}55` : 'rgba(255,255,255,0.12)'}`,
          borderRadius: 7,
          background: action === 'approve' ? `${EMERALD}10` : action === 'reject' ? `${ROSE}0d` : 'rgba(255,255,255,0.025)',
          padding: '6px 9px',
          color: busy ? TEXT_QUIET : action === 'approve' ? EMERALD : action === 'reject' ? ROSE : TEXT_MUTED,
          fontSize: 9.5,
          fontWeight: 650,
          cursor: busy ? 'default' : 'pointer',
          textTransform: 'capitalize',
        }}
      >{action}</button>)}
      {busy && <span style={{ fontSize: 9.5, color: TEXT_QUIET }}>Recording…</span>}
    </div>}

    {error && <div style={{ marginTop: 7, fontSize: 9.5, lineHeight: 1.45, color: ROSE }}>{error}</div>}
  </div>
}
