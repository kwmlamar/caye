import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { AI_PROVIDER_IDS, type AIProviderId } from './types'

/**
 * Founder-controlled provider configuration: enable/disable and routing
 * priority. Internal infrastructure — deliberately NOT workspace-scoped and
 * never exposed to a customer workspace. Caye's customers hired an employee,
 * not a model-vendor dashboard.
 *
 * Absent row means enabled with no priority override, so an empty table is a
 * valid, working production state.
 */
export interface ProviderSetting {
  provider: AIProviderId
  enabled: boolean
  /** Lower sorts earlier. Null leaves the compiled task route untouched. */
  priority: number | null
  updatedAt: string | null
}

const CACHE_TTL_MS = Number(process.env.CAYE_AI_SETTINGS_CACHE_MS || 15_000)
let cache: { at: number; rows: Map<AIProviderId, ProviderSetting> } | null = null

export function resetProviderSettingsCache(): void {
  cache = null
}

function defaults(): Map<AIProviderId, ProviderSetting> {
  return new Map(
    AI_PROVIDER_IDS.map((provider) => [provider, { provider, enabled: true, priority: null, updatedAt: null }])
  )
}

export async function loadProviderSettings(force = false): Promise<Map<AIProviderId, ProviderSetting>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows

  const rows = defaults()
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase.from('ai_provider_settings').select('*')
    if (error) throw error
    for (const raw of data ?? []) {
      const row = raw as Record<string, unknown>
      const provider = row.provider as AIProviderId
      if (!AI_PROVIDER_IDS.includes(provider)) continue
      rows.set(provider, {
        provider,
        enabled: row.enabled !== false,
        priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
        updatedAt: (row.updated_at as string) ?? null,
      })
    }
  } catch (error) {
    // Same fail-open rule as health: a settings outage must not disable AI.
    console.warn('[ai/provider-settings] settings unavailable, using defaults:', error instanceof Error ? error.message : String(error))
  }

  cache = { at: Date.now(), rows }
  return rows
}

export async function setProviderEnabled(provider: AIProviderId, enabled: boolean): Promise<void> {
  await upsert(provider, { enabled })
}

export async function setProviderPriority(provider: AIProviderId, priority: number | null): Promise<void> {
  await upsert(provider, { priority })
}

async function upsert(provider: AIProviderId, patch: Record<string, unknown>): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('ai_provider_settings')
    .upsert({ provider, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'provider' })
  if (error) throw error
  resetProviderSettingsCache()
}

/**
 * Priority order derived from settings, or null when nobody has expressed a
 * preference. Feeds the same reorder path as CAYE_AI_PROVIDER_ORDER.
 */
export function priorityOrder(settings: Map<AIProviderId, ProviderSetting>): AIProviderId[] | null {
  const withPriority = [...settings.values()].filter((s) => s.priority !== null)
  if (withPriority.length === 0) return null
  return withPriority.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((s) => s.provider)
}
