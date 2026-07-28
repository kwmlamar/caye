'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { Pill } from '@/components/dashboard/founder-home/console-ui'
import type { CustomerStatus } from '@/types/database'

const CARD_BG = '#1a1a1e'
const LABEL_COLOR = '#71717a'

const STATUS_LABEL: Record<CustomerStatus, string> = {
  active: 'Live',
  trial: 'Trial',
  inactive: 'Dormant',
  suspended: 'Blocked',
}
const STATUS_COLOR: Record<CustomerStatus, string> = {
  active: '#34d399',
  trial: '#FFE4AF',
  inactive: '#71717a',
  suspended: '#fb7185',
}

function StatusPill({ status }: { status: CustomerStatus }) {
  return <Pill color={STATUS_COLOR[status]} label={STATUS_LABEL[status]} />
}

interface CostRow {
  workspace_id: string
  business_name: string
  status: CustomerStatus
  llm_cost_7d_usd: number
  llm_cost_30d_usd: number
  llm_calls_30d: number
  meta_cost_30d_usd: number | null
  monthly_price_usd: number | null
  revenue_source: 'stripe' | 'manual' | 'none'
  subscription_status: string | null
  margin_usd: number | null
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

// Cross-workspace "what does it cost to run Caye, and is that workspace
// profitable" monitor. Split out of Global Performance (2026-07-28), which
// used to render this same LLM-cost table before Cost became its own
// page. Meta/WhatsApp conversation-based cost isn't tracked anywhere in
// the codebase yet (no credentials, no sync job) — shown as an explicit
// "not tracked yet" rather than a fabricated $0, so margin isn't
// overstated. Monthly price is a live Stripe lookup for any workspace
// mapped in lib/workspace-pricing.ts, falling back to a manually-typed
// figure otherwise (or if the Stripe call fails) — the "Stripe"/"manual"
// pill below each price says which. Read-only; no actions.
export default function CostPage() {
  const [rows, setRows] = useState<CostRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/cost', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (cancelled) return
      if (!res.ok) { setError(json.error ?? 'Failed to load'); return }
      setRows(json.workspaces ?? [])
    }
    load()
    return () => { cancelled = true }
  }, [])

  const totalLlmCost30d = rows?.reduce((acc, r) => acc + r.llm_cost_30d_usd, 0) ?? 0
  const totalRevenue = rows?.reduce((acc, r) => acc + (r.monthly_price_usd ?? 0), 0) ?? 0
  const totalMargin = rows?.reduce((acc, r) => acc + (r.margin_usd ?? 0), 0) ?? 0

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      <div style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <div style={{ background: CARD_BG, borderRadius: 18, padding: '16px 18px' }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 8 }}>
            30-day LLM cost (all workspaces)
          </div>
          <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {rows ? fmtUsd(totalLlmCost30d) : '—'}
          </div>
        </div>
        <div style={{ background: CARD_BG, borderRadius: 18, padding: '16px 18px' }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 8 }}>
            Monthly revenue (known)
          </div>
          <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {rows ? fmtUsd(totalRevenue) : '—'}
          </div>
        </div>
        <div style={{ background: CARD_BG, borderRadius: 18, padding: '16px 18px' }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 8 }}>
            Margin (LLM-cost only)
          </div>
          <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: totalMargin < 0 ? '#fb7185' : '#34d399' }}>
            {rows ? fmtUsd(totalMargin) : '—'}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: '#52525b', lineHeight: 1.5, flexShrink: 0 }}>
        Meta/WhatsApp conversation-based cost isn&apos;t tracked yet — margin above reflects LLM cost only. Price/mo is a live Stripe lookup where a customer ID is on file (dot = ●), otherwise a manually-typed fallback (dot = ○) — see lib/workspace-pricing.ts.
      </div>

      <div style={{ flex: 1, minHeight: 0, background: CARD_BG, borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 100px 110px 110px 100px 100px 100px',
          padding: '10px 16px', background: 'rgba(255,255,255,0.025)',
          fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR,
        }}>
          <span>Workspace</span>
          <span>Status</span>
          <span style={{ textAlign: 'right' }}>7-day LLM</span>
          <span style={{ textAlign: 'right' }}>30-day LLM</span>
          <span style={{ textAlign: 'right' }}>Meta cost</span>
          <span style={{ textAlign: 'right' }}>Price/mo</span>
          <span style={{ textAlign: 'right' }}>Margin</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {error ? (
            <div style={{ padding: 16, fontSize: 12.5, color: '#fb7185' }}>{error}</div>
          ) : rows === null ? (
            <div style={{ padding: 16 }}><CayeLoadingPulse size={16} /></div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12.5, color: '#52525b' }}>No workspaces.</div>
          ) : (
            rows.map((r) => (
              <div
                key={r.workspace_id}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 100px 110px 110px 100px 100px 100px',
                  padding: '11px 16px', alignItems: 'center',
                  boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: '#f4f4f5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8 }}>
                  {r.business_name}
                </span>
                <StatusPill status={r.status} />
                <span style={{ fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a1a1aa' }}>
                  {fmtUsd(r.llm_cost_7d_usd)}
                </span>
                <span style={{ fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {fmtUsd(r.llm_cost_30d_usd)}
                </span>
                <span title="Meta/WhatsApp conversation cost isn't tracked yet" style={{ fontSize: 13, textAlign: 'right', color: '#52525b' }}>
                  —
                </span>
                <span
                  title={
                    r.revenue_source === 'stripe'
                      ? `Live from Stripe — subscription ${r.subscription_status}`
                      : r.revenue_source === 'manual'
                        ? 'Manually-typed fallback (lib/workspace-pricing.ts) — no Stripe customer ID on file, or the live lookup failed'
                        : 'No price on file'
                  }
                  style={{
                    fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                    color: r.monthly_price_usd === null ? '#52525b' : '#f4f4f5',
                    display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 4,
                  }}
                >
                  {r.revenue_source !== 'none' && (
                    <span aria-hidden style={{ fontSize: 9, color: r.revenue_source === 'stripe' ? '#4EBECE' : '#52525b' }}>
                      {r.revenue_source === 'stripe' ? '●' : '○'}
                    </span>
                  )}
                  {r.monthly_price_usd === null ? '—' : fmtUsd(r.monthly_price_usd)}
                </span>
                <span
                  style={{
                    fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                    color: r.margin_usd === null ? '#52525b' : r.margin_usd < 0 ? '#fb7185' : '#34d399',
                  }}
                >
                  {r.margin_usd === null ? '—' : fmtUsd(r.margin_usd)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
