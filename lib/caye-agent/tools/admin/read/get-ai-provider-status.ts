import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'
import {
  AI_PROVIDER_IDS,
  isCircuitOpen,
  loadProviderHealth,
  loadProviderSettings,
  MODELS,
  providerAdapter,
  TASK_ROUTES,
} from '@/lib/ai'

/**
 * Dual-channel counterpart to the founder rail's "AI providers" tab.
 *
 * Per the founder-tooling rule, an internal surface should be reachable both
 * in the dashboard and by asking Caye — the failure this exists for (a
 * provider going down) is exactly the kind of thing Lamar finds out about
 * from his phone, not from a browser tab.
 *
 * Read-only. Enabling/disabling a provider stays in the dashboard: it is a
 * consequential configuration change and does not belong behind a chat turn.
 */
export const getAiProviderStatus: Tool<Record<string, never>> = {
  name: 'get_ai_provider_status',
  description:
    'Report which AI provider Caye is currently routing to, which providers are unavailable and why (billing, auth, rate limit, outage), and how often failover happened in the last 24 hours. Call this before answering any question about which model or provider Caye is running on — never guess.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell'],
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute() {
    const [health, settings] = await Promise.all([loadProviderHealth(true), loadProviderSettings(true)])

    const providers = AI_PROVIDER_IDS.map((id) => {
      const h = health.get(id)
      const enabled = settings.get(id)?.enabled !== false
      const hasKey = providerAdapter(id)?.hasCredentials() ?? false
      const open = isCircuitOpen(h)
      return {
        provider: id,
        status: !hasKey ? 'no_credentials' : !enabled ? 'disabled' : open ? 'unavailable' : 'healthy',
        unavailable_reason: open ? h?.reason ?? null : null,
        detail: open ? h?.detail ?? null : null,
        cooldown_until: open ? h?.cooldownUntil ?? null : null,
        last_success_at: h?.lastSuccessAt ?? null,
        last_failure_at: h?.lastFailureAt ?? null,
      }
    })

    const serving = providers.find((p) => p.status === 'healthy')?.provider ?? null

    const since = new Date(Date.now() - 24 * 3600_000).toISOString()
    const supabase = createServiceClient()
    const { data: rows } = await supabase
      .from('llm_call_log')
      .select('provider, outcome, fallback_used')
      .gte('called_at', since)
      .not('provider', 'is', null)
      .limit(20000)

    const calls = rows ?? []

    return {
      ok: true,
      data: {
        currently_serving: serving,
        providers,
        default_route_for_customer_replies: TASK_ROUTES.customer_response.map(
          (key) => `${MODELS[key].provider}/${MODELS[key].id}`
        ),
        last_24h: {
          calls: calls.length,
          failovers: calls.filter((c) => c.fallback_used).length,
          failed: calls.filter((c) => c.outcome === 'failure').length,
          by_provider: Object.fromEntries(
            AI_PROVIDER_IDS.map((id) => [id, calls.filter((c) => c.provider === id).length])
          ),
        },
      },
    }
  },
}
