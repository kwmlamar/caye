import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { policyFor } from './errors'
import { providerAdapter } from './providers'
import { AI_PROVIDER_IDS, type AIErrorCategory, type AIProviderId } from './types'

/**
 * Provider circuit breaker.
 *
 * Purpose is narrow: when Anthropic is out of credit, Caye must not pay a
 * failed round trip to Anthropic on *every* customer message for the next
 * half hour. It must find that out once and route past it.
 *
 * Multi-instance safety: Caye runs on Vercel, so process memory is not a
 * shared fact. State lives in `ai_provider_health` (one row per provider,
 * three rows total) with a short in-process cache in front of it so the
 * common path is not a database round trip per AI call.
 *
 * Deliberately NOT a distributed system. Three providers do not justify
 * leases, quorums or locks. Concurrent writers race on a single row and the
 * last write wins; the worst case is a slightly wrong cooldown timestamp,
 * which self-corrects on the next success or failure.
 *
 * Fails OPEN by design: if the health store is unreachable, providers are
 * treated as eligible. A telemetry outage must never take Caye's AI offline.
 */
export interface ProviderHealth {
  provider: AIProviderId
  state: 'healthy' | 'cooldown'
  reason: AIErrorCategory | null
  detail: string | null
  consecutiveFailures: number
  cooldownUntil: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  /** Fingerprint of the credential in use when the circuit opened. */
  credentialFingerprint: string | null
}

const CACHE_TTL_MS = Number(process.env.CAYE_AI_HEALTH_CACHE_MS || 5_000)

let cache: { at: number; rows: Map<AIProviderId, ProviderHealth> } | null = null

export function resetHealthCache(): void {
  cache = null
}

function blank(provider: AIProviderId): ProviderHealth {
  return {
    provider,
    state: 'healthy',
    reason: null,
    detail: null,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    credentialFingerprint: null,
  }
}

function fromRow(row: Record<string, unknown>): ProviderHealth {
  return {
    provider: row.provider as AIProviderId,
    state: row.state === 'cooldown' ? 'cooldown' : 'healthy',
    reason: (row.reason as AIErrorCategory) ?? null,
    detail: (row.detail as string) ?? null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    cooldownUntil: (row.cooldown_until as string) ?? null,
    lastSuccessAt: (row.last_success_at as string) ?? null,
    lastFailureAt: (row.last_failure_at as string) ?? null,
    credentialFingerprint: (row.credential_fingerprint as string) ?? null,
  }
}

export async function loadProviderHealth(force = false): Promise<Map<AIProviderId, ProviderHealth>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows

  const rows = new Map<AIProviderId, ProviderHealth>()
  for (const provider of AI_PROVIDER_IDS) rows.set(provider, blank(provider))

  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase.from('ai_provider_health').select('*')
    if (error) throw error
    for (const row of data ?? []) {
      const health = fromRow(row as Record<string, unknown>)
      if (AI_PROVIDER_IDS.includes(health.provider)) rows.set(health.provider, health)
    }
  } catch (error) {
    // Fail open. See the doc comment.
    console.warn('[ai/health] health store unavailable, treating all providers as eligible:', describe(error))
  }

  cache = { at: Date.now(), rows }
  return rows
}

/**
 * Is the circuit currently open for this provider?
 *
 * A cooldown opened on a billing or auth failure is released early when the
 * credential changes — rotating a key or topping up an account and
 * redeploying should bring the provider back immediately, not 30 minutes
 * later. That is the difference between a breaker and a punishment.
 */
export function isCircuitOpen(health: ProviderHealth | undefined, now = Date.now()): boolean {
  if (!health || health.state !== 'cooldown' || !health.cooldownUntil) return false
  if (new Date(health.cooldownUntil).getTime() <= now) return false

  if (health.reason === 'billing_exhausted' || health.reason === 'authentication') {
    const current = providerAdapter(health.provider)?.credentialFingerprint()
    if (health.credentialFingerprint && current && current !== health.credentialFingerprint) return false
  }
  return true
}

export async function recordProviderSuccess(provider: AIProviderId): Promise<void> {
  const now = new Date().toISOString()
  patchCache(provider, (h) => ({
    ...h,
    state: 'healthy',
    reason: null,
    detail: null,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastSuccessAt: now,
  }))
  await write(provider, {
    state: 'healthy',
    reason: null,
    detail: null,
    consecutive_failures: 0,
    cooldown_until: null,
    last_success_at: now,
  })
}

export async function recordProviderFailure(
  provider: AIProviderId,
  category: AIErrorCategory,
  detail: string
): Promise<void> {
  const policy = policyFor(category)
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  const rows = await loadProviderHealth()
  const previous = rows.get(provider) ?? blank(provider)
  // Only availability-shaped failures accumulate. A malformed request is
  // Caye's bug and must not make a healthy provider look sick.
  const failures = policy.opensCircuit ? previous.consecutiveFailures + 1 : previous.consecutiveFailures
  const opens = policy.opensCircuit && failures >= policy.failureThreshold
  const cooldownUntil = opens ? new Date(now + policy.cooldownMs).toISOString() : previous.cooldownUntil

  const next: ProviderHealth = {
    ...previous,
    state: opens ? 'cooldown' : previous.state,
    reason: opens ? category : previous.reason,
    detail: opens ? detail.slice(0, 500) : previous.detail,
    consecutiveFailures: failures,
    cooldownUntil,
    lastFailureAt: nowIso,
    credentialFingerprint: opens ? providerAdapter(provider)?.credentialFingerprint() ?? null : previous.credentialFingerprint,
  }
  patchCache(provider, () => next)

  await write(provider, {
    state: next.state,
    reason: next.reason,
    detail: next.detail,
    consecutive_failures: next.consecutiveFailures,
    cooldown_until: next.cooldownUntil,
    last_failure_at: next.lastFailureAt,
    credential_fingerprint: next.credentialFingerprint,
  })
}

/** Founder action from the admin surface: force a provider back into rotation. */
export async function clearProviderCircuit(provider: AIProviderId): Promise<void> {
  patchCache(provider, (h) => ({ ...h, state: 'healthy', reason: null, detail: null, consecutiveFailures: 0, cooldownUntil: null }))
  await write(provider, { state: 'healthy', reason: null, detail: null, consecutive_failures: 0, cooldown_until: null })
}

function patchCache(provider: AIProviderId, update: (h: ProviderHealth) => ProviderHealth): void {
  if (!cache) return
  cache.rows.set(provider, update(cache.rows.get(provider) ?? blank(provider)))
}

async function write(provider: AIProviderId, patch: Record<string, unknown>): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('ai_provider_health')
      .upsert({ provider, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'provider' })
    if (error) throw error
  } catch (error) {
    console.warn(`[ai/health] could not persist health for ${provider}:`, describe(error))
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
