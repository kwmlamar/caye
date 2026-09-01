'use client'

import { useCallback, useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { GhostButton, Pill } from '@/components/dashboard/founder-home/console-ui'
import { quietPanel, rowDivider, EMERALD, ROSE, GOLD, TEXT, TEXT_MUTED, TEXT_QUIET } from '@/components/dashboard/surface'

/**
 * Founder-only AI provider surface.
 *
 * The default answer this page should give is "Routing: Auto, nothing to do."
 * It earns its place on the day Anthropic runs out of credit — then it has to
 * say, in one glance, which provider is serving Caye, which one is down, why,
 * and what the founder can do about it. Everything below is ordered by that
 * priority; the per-task routing table is collapsed because it is reference,
 * not a decision.
 *
 * Internal infrastructure by design — this is never rendered in a customer
 * workspace. Caye's customers hired an employee, not a model-vendor console.
 */

type Status = 'healthy' | 'unavailable' | 'disabled' | 'no_credentials'

interface ProviderRow {
  id: 'anthropic' | 'openai' | 'openrouter'
  label: string
  enabled: boolean
  priority: number | null
  hasCredentials: boolean
  envVar: string
  status: Status
  reason: string | null
  detail: string | null
  cooldownUntil: string | null
  consecutiveFailures: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  models: { id: string; tier: string }[]
  last24h: {
    calls: number
    failures: number
    servedAfterFallback: number
    medianLatencyMs: number | null
    topFailure: string | null
  }
}

interface Payload {
  routingMode: 'auto' | 'manual'
  priorityOverrideSource: string | null
  providers: ProviderRow[]
  routes: Record<string, { provider: string; model: string; tier: string }[]>
  last24h: {
    calls: number
    failovers: number
    failures: number
    byTask: Record<string, { calls: number; failovers: number; providers: Record<string, number> }>
  }
}

const STATUS_META: Record<Status, { color: string; label: string }> = {
  healthy: { color: EMERALD, label: 'Healthy' },
  unavailable: { color: ROSE, label: 'Unavailable' },
  disabled: { color: TEXT_QUIET, label: 'Disabled' },
  no_credentials: { color: GOLD, label: 'No key' },
}

/** Error categories are internal vocabulary; the founder gets plain English. */
const REASON_TEXT: Record<string, string> = {
  billing_exhausted: 'Billing / credits exhausted',
  authentication: 'API key rejected',
  quota: 'Quota exhausted',
  rate_limit: 'Rate limited',
  timeout: 'Requests timing out',
  network: 'Network unreachable',
  upstream_5xx: 'Provider returning errors',
  unknown: 'Repeated unexplained failures',
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function until(iso: string | null): string {
  if (!iso) return ''
  const mins = Math.ceil((new Date(iso).getTime() - Date.now()) / 60000)
  return mins > 0 ? `retrying in ${mins}m` : 'retrying now'
}

export default function AiProvidersPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [showRoutes, setShowRoutes] = useState(false)

  const load = useCallback(async () => {
    try {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/ai-providers', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) throw new Error(`Failed to load providers (${res.status})`)
      setData(await res.json())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act = useCallback(
    async (provider: string, action: string, extra: Record<string, unknown> = {}) => {
      setBusy(`${provider}:${action}`)
      try {
        const { session } = await getSession()
        if (!session) return
        const res = await fetch('/api/founder/ai-providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ provider, action, ...extra }),
        })
        const json = await res.json()
        if (action === 'test') {
          setTestResult((prev) => ({
            ...prev,
            [provider]: json.ok
              ? `Connected in ${json.latencyMs}ms via ${json.model}`
              : `Failed: ${REASON_TEXT[json.category] ?? json.category}`,
          }))
        }
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
      }
    },
    [load]
  )

  if (error) return <div style={{ padding: 20, color: ROSE, fontSize: 13 }}>{error}</div>
  if (!data) return <div style={{ padding: 40 }}><CayeLoadingPulse /></div>

  const serving = data.providers.find((p) => p.status === 'healthy')

  return (
    <div style={{ padding: '20px 0 40px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: TEXT, margin: 0 }}>AI providers</h2>
          <Pill
            color={data.routingMode === 'auto' ? EMERALD : GOLD}
            label={data.routingMode === 'auto' ? 'Routing: Auto' : 'Routing: Manual'}
          />
        </div>
        <p style={{ fontSize: 12.5, color: TEXT_MUTED, margin: '6px 0 0', maxWidth: 640, lineHeight: 1.5 }}>
          {serving
            ? `Caye is routing to ${serving.label} first and will fall through automatically if it becomes unavailable.`
            : 'No provider is currently eligible. Caye cannot serve AI requests until one is restored.'}
          {data.priorityOverrideSource && ` Priority is pinned by ${data.priorityOverrideSource}.`}
        </p>
        <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 12, color: TEXT_MUTED }}>
          <span><strong style={{ color: TEXT }}>{data.last24h.calls}</strong> calls / 24h</span>
          <span><strong style={{ color: data.last24h.failovers ? GOLD : TEXT }}>{data.last24h.failovers}</strong> served after failover</span>
          <span><strong style={{ color: data.last24h.failures ? ROSE : TEXT }}>{data.last24h.failures}</strong> failed outright</span>
        </div>
      </header>

      <div style={{ borderRadius: 14, overflow: 'hidden', ...quietPanel }}>
        {data.providers.map((provider, index) => {
          const meta = STATUS_META[provider.status]
          return (
            <div key={provider.id} style={{ padding: '14px 16px', borderTop: index === 0 ? undefined : rowDivider }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: TEXT }}>{provider.label}</span>
                <Pill color={meta.color} label={meta.label} />
                {provider.priority !== null && <Pill color={GOLD} label={`Priority ${provider.priority}`} dot={false} />}
                <span style={{ flex: 1 }} />
                <GhostButton
                  label={provider.enabled ? 'Disable' : 'Enable'}
                  color={provider.enabled ? TEXT_QUIET : EMERALD}
                  busy={busy === `${provider.id}:set_enabled`}
                  onClick={() => act(provider.id, 'set_enabled', { enabled: !provider.enabled })}
                />
                <GhostButton
                  label="Test"
                  color={TEXT_MUTED}
                  busy={busy === `${provider.id}:test`}
                  disabled={!provider.hasCredentials}
                  onClick={() => act(provider.id, 'test')}
                />
                {provider.status === 'unavailable' && (
                  <GhostButton
                    label="Retry now"
                    color={GOLD}
                    busy={busy === `${provider.id}:clear_circuit`}
                    onClick={() => act(provider.id, 'clear_circuit')}
                  />
                )}
              </div>

              <div style={{ marginTop: 6, fontSize: 12, color: TEXT_MUTED, lineHeight: 1.6 }}>
                {provider.status === 'no_credentials' && <div>{provider.envVar} is not set. Caye is routing around it.</div>}
                {provider.status === 'unavailable' && (
                  <div style={{ color: ROSE }}>
                    {REASON_TEXT[provider.reason ?? 'unknown'] ?? provider.reason}
                    {provider.cooldownUntil ? ` — ${until(provider.cooldownUntil)}` : ''}
                  </div>
                )}
                {provider.detail && provider.status === 'unavailable' && (
                  <div style={{ color: TEXT_QUIET, fontSize: 11.5 }}>{provider.detail}</div>
                )}
                <div>
                  Last success {ago(provider.lastSuccessAt)}
                  {provider.lastFailureAt ? ` · last failure ${ago(provider.lastFailureAt)}` : ''}
                  {' · '}
                  {provider.models.map((m) => m.id).join(', ')}
                </div>
                <div style={{ color: TEXT_QUIET }}>
                  24h: {provider.last24h.calls} calls
                  {provider.last24h.failures > 0 && `, ${provider.last24h.failures} failed`}
                  {provider.last24h.topFailure && ` (${REASON_TEXT[provider.last24h.topFailure] ?? provider.last24h.topFailure})`}
                  {provider.last24h.medianLatencyMs !== null && `, median ${provider.last24h.medianLatencyMs}ms`}
                </div>
                {testResult[provider.id] && (
                  <div style={{ color: testResult[provider.id].startsWith('Failed') ? ROSE : EMERALD }}>
                    {testResult[provider.id]}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ borderRadius: 14, overflow: 'hidden', ...quietPanel }}>
        <button
          onClick={() => setShowRoutes((v) => !v)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px',
            border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
            fontSize: 12.5, fontWeight: 600, color: TEXT,
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={TEXT_QUIET} strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: showRoutes ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
          Routing by task
          <span style={{ fontWeight: 400, color: TEXT_QUIET }}>
            — what Caye tries first for each kind of work
          </span>
        </button>
        {showRoutes && (
          <div style={{ padding: '0 16px 14px' }}>
            {Object.entries(data.routes).map(([task, chain]) => {
              const usage = data.last24h.byTask[task]
              return (
                <div key={task} style={{ padding: '7px 0', borderTop: rowDivider, fontSize: 12 }}>
                  <div style={{ color: TEXT, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{task}</div>
                  <div style={{ color: TEXT_MUTED, marginTop: 2 }}>
                    {chain.map((step, i) => `${i + 1}. ${step.provider}/${step.model}`).join('  →  ')}
                  </div>
                  {usage && (
                    <div style={{ color: TEXT_QUIET, marginTop: 2 }}>
                      {usage.calls} calls / 24h{usage.failovers > 0 && `, ${usage.failovers} after failover`}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
