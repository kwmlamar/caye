import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Reconciles whatsapp_templates against the live template definitions Meta
 * actually validates sends against.
 *
 * Why this exists: whatsapp_templates was hand-maintained and nothing ever
 * checked it against Meta. caye_morning_digest was edited on Meta
 * 2026-07-21 (3 → 4 placeholders, adding the "Oldest waiting:" list) while
 * our row still read placeholder_count=3 / status=pending. The send path
 * trusts that row — morningDigestSupports4Placeholders() in the outbound
 * worker deliberately sends only 3 params until the table says otherwise —
 * so every digest after the edit was rejected by Meta with 132000 "Number
 * of parameters does not match the expected number of params". Bimini's
 * morning digest stayed broken for a week; it surfaced only because a
 * founder alert happened to get read. Confirmed live 2026-07-28.
 *
 * The send path's template guards are only as truthful as this table, so
 * keeping it in sync is what makes those guards meaningful rather than
 * actively misleading.
 *
 * Deliberately updates existing rows only. Templates live on Meta that we
 * don't have a row for are reported in the summary, not inserted: a row
 * here means "Caye's code sends this", which is a code change (and a
 * migration), not something a sync job should invent. Rows we track that
 * Meta no longer has are reported too — that's a template deleted out from
 * under a live send path.
 */

const GRAPH_VERSION = 'v19.0'
const MAX_PAGES = 10

interface MetaComponent {
  type?: string
  text?: string
}

interface MetaTemplate {
  id?: string
  name?: string
  status?: string
  category?: string
  language?: string
  components?: MetaComponent[]
}

export interface TemplateSyncSummary extends Record<string, unknown> {
  skipped_no_config?: string
  fetched: number
  checked: number
  updated: number
  unchanged: number
  untracked_on_meta: string[]
  missing_on_meta: string[]
  changes: string[]
}

/**
 * Meta's status vocabulary is wider than this table's CHECK constraint
 * (pending | approved | rejected). Only APPROVED is sendable, so everything
 * that blocks sending collapses to 'rejected' — semantically loose for
 * PAUSED/DISABLED, but it makes the send-side guard (status === 'approved')
 * fail closed, which is the behaviour that matters. Anything still in
 * review maps to 'pending'.
 *
 * Note APPROVED is what Meta reports for a template showing "Active —
 * Quality pending" in WhatsApp Manager: quality is a separate score, not an
 * approval state, and such templates send fine.
 */
function mapStatus(metaStatus: string | undefined): 'approved' | 'pending' | 'rejected' {
  switch ((metaStatus ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'REJECTED':
    case 'PAUSED':
    case 'DISABLED':
      return 'rejected'
    default:
      // PENDING, IN_APPEAL, PENDING_DELETION, and anything Meta adds later.
      return 'pending'
  }
}

function mapCategory(metaCategory: string | undefined): 'authentication' | 'utility' | 'marketing' | null {
  const c = (metaCategory ?? '').toUpperCase()
  if (c === 'AUTHENTICATION') return 'authentication'
  if (c === 'UTILITY') return 'utility'
  if (c === 'MARKETING') return 'marketing'
  return null
}

function bodyTextOf(tmpl: MetaTemplate): string | null {
  const body = (tmpl.components ?? []).find((c) => (c.type ?? '').toUpperCase() === 'BODY')
  return body?.text ?? null
}

/**
 * Counts the params a send must supply for the BODY component — the only
 * component sendTemplateWhatsApp ever builds, so HEADER/BUTTON params are
 * deliberately not counted here.
 *
 * Positional templates ({{1}}, {{2}}) use the highest index rather than the
 * match count: Meta requires params up to the highest index, and a body
 * that repeats {{1}} would otherwise under-count.
 */
export function bodyPlaceholderCount(bodyText: string | null): number {
  if (!bodyText) return 0
  const tokens = [...bodyText.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1])
  if (tokens.length === 0) return 0

  const indices = tokens.map((t) => Number(t)).filter((n) => Number.isInteger(n) && n > 0)
  if (indices.length === tokens.length) return Math.max(...indices)
  // Named params ({{first_name}}) — count distinct names instead.
  return new Set(tokens).size
}

type SupabaseClient = ReturnType<typeof createServiceClient>

/**
 * The platform WABA that owns the caye_* templates, most-authoritative
 * first:
 *   1. CAYE_PLATFORM_WHATSAPP_BUSINESS_ACCOUNT_ID — explicit, unambiguous.
 *   2. platform_settings — self-populated by the operator webhook from
 *      entry[].id (see app/api/webhooks/whatsapp-operator), which is the
 *      platform WABA by construction: that handler only proceeds after
 *      matching the platform phone_number_id.
 *   3. WHATSAPP_BUSINESS_ACCOUNT_ID — legacy/generic, and ambiguous about
 *      whether it's the platform account or a customer's, so it's the last
 *      resort. Querying the wrong WABA is non-destructive (no caye_*
 *      templates come back, so nothing updates — they just land in
 *      missing_on_meta), but it is useless, hence lowest priority.
 */
async function resolveWabaId(supabase: SupabaseClient): Promise<string | null> {
  if (process.env.CAYE_PLATFORM_WHATSAPP_BUSINESS_ACCOUNT_ID) {
    return process.env.CAYE_PLATFORM_WHATSAPP_BUSINESS_ACCOUNT_ID
  }

  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'whatsapp_business_account_id')
    .maybeSingle()
  const stored = data?.value as string | undefined
  if (stored) return stored

  return process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null
}

async function fetchMetaTemplates(wabaId: string, accessToken: string): Promise<MetaTemplate[]> {
  const all: MetaTemplate[] = []
  let url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates` +
    `?fields=name,status,category,language,components&limit=100`

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    const text = await res.text()
    let json: { data?: MetaTemplate[]; paging?: { next?: string }; error?: { message?: string } } = {}
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`Meta returned non-JSON (http ${res.status}): ${text.slice(0, 200)}`)
    }
    if (!res.ok) {
      throw new Error(`Meta http ${res.status}: ${json.error?.message ?? text.slice(0, 200)}`)
    }
    all.push(...(json.data ?? []))
    url = json.paging?.next ?? ''
  }

  return all
}

/**
 * Meta returns one entry per (name, language). This table is keyed by name
 * alone, so pick the entry whose language matches the row we're updating,
 * preferring an exact match, then a base-language match (en_US → en), then
 * whatever came first — otherwise two languages of the same template would
 * overwrite each other nondeterministically run to run.
 */
function pickForLanguage(candidates: MetaTemplate[], storedLanguage: string): MetaTemplate {
  const stored = storedLanguage.toLowerCase()
  return (
    candidates.find((t) => (t.language ?? '').toLowerCase() === stored) ??
    candidates.find((t) => (t.language ?? '').toLowerCase().split('_')[0] === stored.split('_')[0]) ??
    candidates[0]
  )
}

export async function syncWhatsAppTemplates(): Promise<TemplateSyncSummary> {
  const supabase = createServiceClient()
  const empty: TemplateSyncSummary = {
    fetched: 0,
    checked: 0,
    updated: 0,
    unchanged: 0,
    untracked_on_meta: [],
    missing_on_meta: [],
    changes: [],
  }

  const accessToken = process.env.CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN
  const wabaId = await resolveWabaId(supabase)
  if (!accessToken || !wabaId) {
    // Reported rather than thrown: a missing WABA id is a config gap, not a
    // failure worth paging on every run. It still shows up in the cron
    // summary (and get_cron_health) instead of looking like a clean run.
    return {
      ...empty,
      skipped_no_config: !accessToken
        ? 'missing CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN'
        : 'missing WABA id (set CAYE_PLATFORM_WHATSAPP_BUSINESS_ACCOUNT_ID or platform_settings.whatsapp_business_account_id)',
    }
  }

  const metaTemplates = await fetchMetaTemplates(wabaId, accessToken)

  const byName = new Map<string, MetaTemplate[]>()
  for (const t of metaTemplates) {
    if (!t.name) continue
    const list = byName.get(t.name) ?? []
    list.push(t)
    byName.set(t.name, list)
  }

  const { data: rows, error } = await supabase
    .from('whatsapp_templates')
    .select('name, category, language, body_template, placeholder_count, status, meta_template_id')

  if (error) throw new Error(`whatsapp_templates fetch failed: ${error.message}`)

  const tracked = rows ?? []
  const summary: TemplateSyncSummary = {
    ...empty,
    fetched: metaTemplates.length,
    checked: tracked.length,
    untracked_on_meta: [...byName.keys()].filter((n) => !tracked.some((r) => r.name === n)),
  }

  for (const row of tracked) {
    const candidates = byName.get(row.name)
    if (!candidates?.length) {
      summary.missing_on_meta.push(row.name)
      continue
    }

    const tmpl = pickForLanguage(candidates, (row.language as string) ?? 'en')
    const bodyText = bodyTextOf(tmpl)
    if (!bodyText) {
      // A template with no BODY component isn't something our send path can
      // use; leave the row alone rather than writing a NOT NULL violation.
      summary.missing_on_meta.push(`${row.name} (no body component)`)
      continue
    }

    const next = {
      status: mapStatus(tmpl.status),
      placeholder_count: bodyPlaceholderCount(bodyText),
      body_template: bodyText,
      category: mapCategory(tmpl.category) ?? (row.category as string),
      language: tmpl.language ?? (row.language as string),
      meta_template_id: tmpl.id ?? (row.meta_template_id as string | null),
    }

    const drift: string[] = []
    if (next.status !== row.status) drift.push(`status ${row.status}→${next.status}`)
    if (next.placeholder_count !== row.placeholder_count) {
      drift.push(`params ${row.placeholder_count}→${next.placeholder_count}`)
    }
    if (next.body_template !== row.body_template) drift.push('body')
    if (next.category !== row.category) drift.push(`category ${row.category}→${next.category}`)
    if (next.language !== row.language) drift.push(`language ${row.language}→${next.language}`)
    if (next.meta_template_id !== row.meta_template_id) drift.push('meta_id')

    if (drift.length === 0) {
      summary.unchanged++
      continue
    }

    const { error: updateErr } = await supabase
      .from('whatsapp_templates')
      .update({ ...next, last_synced_at: new Date().toISOString() })
      .eq('name', row.name)

    if (updateErr) {
      console.error(`[template-sync] update failed for ${row.name}:`, updateErr)
      continue
    }

    summary.updated++
    summary.changes.push(`${row.name}: ${drift.join(', ')}`)
  }

  return summary
}

// ---------------------------------------------------------------------------
// Self-heal on param mismatch
// ---------------------------------------------------------------------------

let lastResyncAt = 0
const RESYNC_THROTTLE_MS = 5 * 60 * 1000

/**
 * Fire-and-forget resync triggered by a live 132xxx template error, so a
 * template edited on Meta repairs itself on the next send attempt instead
 * of staying broken until the next scheduled sync (or, before this existed,
 * until a human traced an alert back by hand).
 *
 * Throttled per process — the outbound worker walks a batch of rows in one
 * invocation, and a template mismatch usually fails several at once; they
 * should produce one resync, not one each. Cross-instance duplicates are
 * possible and harmless (the sync is idempotent).
 */
export function resyncTemplatesAfterParamMismatch(reason: string): void {
  const now = Date.now()
  if (now - lastResyncAt < RESYNC_THROTTLE_MS) return
  lastResyncAt = now

  syncWhatsAppTemplates()
    .then((summary) => {
      if (summary.updated > 0) {
        console.log(`[template-sync] self-heal after ${reason}:`, summary.changes)
      }
    })
    .catch((err) => console.error('[template-sync] self-heal failed:', err))
}
