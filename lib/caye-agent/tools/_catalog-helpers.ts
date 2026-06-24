import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import { matchServiceByName } from '@/lib/services/match-service'

interface ServiceRow {
  id: string
  name: string
  slug: string | null
  active: boolean
  visibility: 'public' | 'private'
}

/**
 * Resolve a free-text service name (the way the operator typed it in
 * WhatsApp — "Sit-Low private", "Full Bimini", "South Bimini tour") to a
 * canonical booking_services row in the workspace.
 *
 * Reuses matchServiceByName from the front-desk path so the operator and
 * Caye share the same fuzzy-match behavior.
 */
export async function resolveServiceByName(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  nameInput: string,
  opts: { includeInactive?: boolean } = {}
): Promise<
  | { ok: true; service: ServiceRow }
  | { ok: false; error: string; candidates?: string[] }
> {
  const name = nameInput.trim()
  if (name.length < 2) return { ok: false, error: 'Service name is too short.' }

  let query = supabase
    .from('booking_services')
    .select('id, name, slug, active, visibility')
    .eq('user_id', workspaceId)
  if (!opts.includeInactive) query = query.eq('active', true)

  const { data, error } = await query
  if (error) return { ok: false, error: error.message }
  const rows = (data ?? []) as ServiceRow[]
  if (rows.length === 0) {
    return { ok: false, error: 'No services configured for this workspace.' }
  }

  const match = matchServiceByName(rows.map((r) => ({ id: r.id, name: r.name })), name)
  if (!match.best || match.confidence === 'low' || match.confidence === 'none') {
    return {
      ok: false,
      error: `No service confidently matches "${name}".`,
      candidates: rows.map((r) => r.name),
    }
  }
  if (match.confidence === 'medium') {
    return {
      ok: false,
      error: `Ambiguous match for "${name}" — pick exact name from candidates.`,
      candidates: match.candidates.map((c) => c.service.name),
    }
  }
  const hit = rows.find((r) => r.id === match.best!.id)
  if (!hit) return { ok: false, error: 'Match lookup failed (row vanished).' }
  return { ok: true, service: hit }
}
