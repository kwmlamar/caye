/**
 * Google Places API for business discovery, then automated website scraping
 * for contact email extraction and a small amount of first-party evidence.
 * A website description is evidence only of what the business says it does.
 *
 * CAY sourcing-supply fix (2026-09-03): the daily sourcing cron used to
 * issue the same 10 fixed (vertical, region) queries every day and always
 * take the first `maxResults` (20) of a deterministic Places result list,
 * so the addressable universe (~200 businesses) was fully consumed within
 * two days and every run since found ~180 "new" results that were entirely
 * duplicates. Three changes address that:
 *   1. `sourceLeads` now takes an `offset` and reports how much of the
 *      query's result set it walked (`consumed`) and how large that result
 *      set was (`totalResults`), so a caller can persist a cursor and
 *      resume past what a prior run already read instead of re-reading the
 *      same head of the list. See `advanceSourcingCursor` below.
 *   2. `VERTICAL_QUERY_VARIANTS` / `getQueryVariants` widen one static
 *      query string per vertical into several, rotated once a variant's
 *      result set is exhausted.
 *   3. `failsIcpFilter` drops businesses that are clearly outside the
 *      owner-operated-SMB ICP (see Products/Caye/ICP.md) before they are
 *      scraped or inserted, using Places `Details` fields beyond the
 *      original four.
 */
import 'server-only'
import { isValidOutreachEmail } from './outreach-email'

export interface PlaceResult { place_id: string; name: string }
export interface PlaceDetails {
  name: string
  formatted_phone_number?: string
  website?: string
  formatted_address?: string
  user_ratings_total?: number
  price_level?: number
  business_status?: string
  types?: string[]
}
export interface SourcedLead { business_name: string; phone: string | null; website: string | null; email: string | null; address: string | null; evidence: string | null }
export interface SourceLeadsResult {
  leads: SourcedLead[]
  /** Businesses whose Place Details were fetched successfully but that failed the ICP filter — visible so the threshold can be tuned against real numbers instead of guessed. */
  rejectedNotIcp: number
  /** Number of place results this call actually walked through (the offset window), regardless of how many yielded a usable lead. This is what a caller advances its persisted cursor by — see `advanceSourcingCursor`. */
  consumed: number
  /** Total results the underlying Places text search returned for this query variant (post Places-side pagination, capped ~60), so a caller can tell whether this window reached the end of the variant's result set. */
  totalResults: number
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const MAILTO_RE = /href\s*=\s*["']mailto:([^"'?\s]+)/gi
const META_TAG_RE = /<meta\b[^>]*>/gi
const MAX_EVIDENCE_LENGTH = 300
const MIN_EVIDENCE_LENGTH = 20
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|[a-z]+);?/gi, (whole, code) => {
    if (code.startsWith('#')) { const n = Number(code.slice(1)); return Number.isFinite(n) ? String.fromCharCode(n) : whole }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}
function attr(tag: string, name: string): string | null {
  const quoted = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
  if (quoted) return quoted[2]
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i'))?.[1] ?? null
}
function extractEvidence(html: string): string | null {
  for (const tag of html.match(META_TAG_RE) ?? []) {
    const key = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase()
    if (key !== 'description' && key !== 'og:description') continue
    const content = attr(tag, 'content')
    if (!content) continue
    const text = decodeEntities(content).replace(/\s+/g, ' ').trim()
    if (text.length < MIN_EVIDENCE_LENGTH) continue
    return text.length > MAX_EVIDENCE_LENGTH ? `${text.slice(0, MAX_EVIDENCE_LENGTH).trim()}…` : text
  }
  return null
}

const EMAIL_BLOCKLIST_PATTERNS = [/\.(png|jpe?g|gif|svg|webp)$/i,/sentry\.io$/i,/wixpress\.com$/i,/schema\.org$/i,/example\.com$/i,/godaddy\.com$/i,/w3\.org$/i,/\.wixsite\.com$/i,/fareharbor\.com$/i,/peek\.com$/i,/bokun\.io$/i,/checkfront\.com$/i,/rezdy\.com$/i,/^user@domain\.com$/i,/^(name|email|test|someone|yourname)@(domain|example|yoursite)\.com$/i,/eyebytes\.com$/i]
function isLikelyRealEmail(email: string): boolean { return isValidOutreachEmail(email) && !EMAIL_BLOCKLIST_PATTERNS.some((re) => re.test(email.toLowerCase())) }

/**
 * Prefers an email found in a `mailto:` href over a bare-text regex match —
 * a mailto target is an explicit, machine-authored contact address; a bare
 * text match can pick up an address in a testimonial, a staff bio, or an
 * unrelated embedded widget. Falls back to the bare-text scan (the original
 * behavior) when no valid mailto is present.
 */
export function extractEmailFromHtml(html: string): string | null {
  const mailtoHit = Array.from(html.matchAll(MAILTO_RE))
    .map((m) => decodeEntities(m[1]).trim())
    .find(isLikelyRealEmail)
  if (mailtoHit) return mailtoHit
  return (html.match(EMAIL_RE) ?? []).find(isLikelyRealEmail) ?? null
}

/**
 * Additional contact-bearing paths beyond the original root/contact/contact-us.
 * Not all are fetched for every business — see MAX_CONTACT_FETCHES.
 */
const CONTACT_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/booking', '/book', '/rates', '/reservations', '/contact.html']
/**
 * Bounds total fetches per business so widening the path list above doesn't
 * blow up per-run wall-clock time. 6 (root + 5) keeps the worst case (every
 * fetch hits the 8s timeout) at ~48s per business, and the loop already
 * breaks as soon as both an email and evidence are found — most real sites
 * resolve on the first 1-2 fetches.
 */
const MAX_CONTACT_FETCHES = 6

/** Pure — builds the deduplicated, bounded list of URLs `scrapeSite` will fetch for a given website root. Exported for direct unit testing without network mocking. */
export function buildContactCandidateUrls(website: string): string[] {
  const urls = [website, ...CONTACT_PATHS.map((p) => new URL(p, website).toString())]
  return Array.from(new Set(urls)).slice(0, MAX_CONTACT_FETCHES)
}

async function textSearch(query: string, location: string, apiKey: string): Promise<PlaceResult[]> {
  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json'); url.searchParams.set('query', `${query} in ${location}`); url.searchParams.set('key', apiKey)
  const results: PlaceResult[] = []; let pageUrl: string | null = url.toString()
  while (pageUrl && results.length < 60) {
    const data = await (await fetch(pageUrl)).json(); if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') break; results.push(...(data.results ?? []))
    if (!data.next_page_token) pageUrl = null
    else { await new Promise((r) => setTimeout(r, 2000)); const next = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json'); next.searchParams.set('pagetoken', data.next_page_token); next.searchParams.set('key', apiKey); pageUrl = next.toString() }
  }
  return results
}
async function getPlaceDetails(placeId: string, apiKey: string): Promise<PlaceDetails | null> {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json'); url.searchParams.set('place_id', placeId); url.searchParams.set('fields', 'name,formatted_phone_number,website,formatted_address,user_ratings_total,price_level,business_status,types'); url.searchParams.set('key', apiKey)
  const data = await (await fetch(url.toString())).json(); return data.status === 'OK' ? data.result as PlaceDetails : null
}
async function scrapeSite(website: string): Promise<{ email: string | null; evidence: string | null }> {
  let candidates: string[]; try { candidates = buildContactCandidateUrls(website) } catch { return { email: null, evidence: null } }
  let email: string | null = null; let evidence: string | null = null
  for (const url of candidates) {
    if (email && evidence) break
    try { const res = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (!res.ok) continue; const html = await res.text(); if (!email) email = extractEmailFromHtml(html); if (!evidence) evidence = extractEvidence(html) } catch { continue }
  }
  return { email, evidence }
}

/**
 * ICP fit filter (Products/Caye/ICP.md: owner-operated Caribbean SMBs, 0-10
 * staff, no internal tech team).
 *
 * `user_ratings_total` is a GIANT DETECTOR, not an ICP proxy — real Places
 * data pulled against production leads (2026-09-03) showed the two
 * populations overlap almost completely and review count does NOT predict
 * fit at SMB scale:
 *
 *   opted-out / bad leads:   Brownstone 1 (85), HumesHouse @ Hillcrest (97),
 *                            Happistart Travel (178), Solemar (446),
 *                            Meze Grill (968), Dolphin Encounters (1130),
 *                            Latitudes (1143), Paranza (2080),
 *                            Atlantis Paradise Island (22857)
 *   genuine ICP prospects:   Outdoor Sportsman Ltd (13), Powerboat
 *                            Adventures (496), Sandy Toes (548), Islandz
 *                            Tours (607), Tru Bahamian Food Tours (814),
 *                            La Caverna (442)
 *
 * A 300 threshold (the original guess) would have rejected four genuine,
 * already-in-the-pipeline ICP prospects (Powerboat Adventures, Sandy Toes,
 * Islandz Tours, Tru Bahamian Food Tours) while happily passing two of the
 * actual bad leads (Brownstone 1 at 85, HumesHouse at 97). Review count
 * does not do real ICP work here — the shared-mail-domain check in
 * lib/outreach-sourcing-job.ts is what the evidence actually supports.
 * This filter now exists only to catch unmistakable mega-operators: 5000
 * sits ~6x above the highest legitimate SMB in the sample (Tru Bahamian
 * Food Tours, 814) and only Atlantis-scale entities clear it. Do not
 * re-tighten this from a hunch — re-derive it from real numbers the way
 * the table above was built, and check the numbers above first.
 */
export const ICP_MAX_USER_RATINGS = 5000
/**
 * Places `price_level` is 0 ("Free") to 4 ("$$$$", very expensive) and
 * rarely populated for tour operators. Kept as a cheap backstop against
 * resort-tier pricing, but the same 2026-09-03 data shows it is
 * near-inert in practice: every problem business in the sample that had a
 * price_level set (Solemar, Meze Grill, Latitudes, Paranza -- and also La
 * Caverna, a genuine ICP prospect) sat at price_level 2. It is not doing
 * real filtering work here; don't let comments elsewhere imply otherwise.
 */
export const ICP_MAX_PRICE_LEVEL = 3

export function failsIcpFilter(details: Pick<PlaceDetails, 'business_status' | 'user_ratings_total' | 'price_level'>): boolean {
  if (details.business_status && details.business_status !== 'OPERATIONAL') return true
  if (typeof details.user_ratings_total === 'number' && details.user_ratings_total > ICP_MAX_USER_RATINGS) return true
  if (typeof details.price_level === 'number' && details.price_level > ICP_MAX_PRICE_LEVEL) return true
  return false
}

/**
 * Query-string variants per vertical, rotated by `getQueryVariants` /
 * `advanceSourcingCursor` once a variant's Places result set is exhausted.
 * One static string per vertical was a narrow keyhole onto each market —
 * "restaurant in Nassau" alone never surfaces a "seafood shack" or "bar and
 * grill" that a different query phrasing returns near the top of Places'
 * relevance ranking. Falls back to the vertical string itself for any
 * vertical not listed here, so an unrecognized/custom vertical still works.
 */
export const VERTICAL_QUERY_VARIANTS: Record<string, string[]> = {
  'tour operator': ['tour operator', 'boat tour', 'snorkel trip', 'charter', 'excursion', 'island tour', 'fishing charter', 'water sports'],
  restaurant: ['restaurant', 'bar and grill', 'seafood restaurant', 'cafe'],
  salon: ['hair salon', 'barbershop', 'nail salon', 'spa'],
  guesthouse: ['guesthouse', 'bed and breakfast', 'villa rental', 'inn'],
}

export function getQueryVariants(vertical: string): string[] {
  return VERTICAL_QUERY_VARIANTS[vertical] ?? [vertical]
}

export interface SourcingCursor { queryVariantIndex: number; resultOffset: number }

/**
 * Pure cursor-advancement logic, exercised directly in tests without any
 * network or database dependency. Given how much of the current query
 * variant's result set a run just consumed, decides whether the next run
 * for this target continues further into the same variant's list or rolls
 * over to the next variant (wrapping around `variantsCount`) starting back
 * at offset 0.
 */
export function advanceSourcingCursor(args: {
  cursor: SourcingCursor
  variantsCount: number
  resultsConsumedInThisPage: number
  totalResultsForVariant: number
}): SourcingCursor {
  const { cursor, variantsCount, resultsConsumedInThisPage, totalResultsForVariant } = args
  const nextOffset = cursor.resultOffset + resultsConsumedInThisPage
  if (nextOffset >= totalResultsForVariant) {
    return { queryVariantIndex: (cursor.queryVariantIndex + 1) % Math.max(variantsCount, 1), resultOffset: 0 }
  }
  return { queryVariantIndex: cursor.queryVariantIndex, resultOffset: nextOffset }
}

export async function sourceLeads(query: string, location: string, maxResults: number = 20, offset: number = 0): Promise<SourceLeadsResult> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY; if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not set')
  const allResults = await textSearch(query, location, apiKey)
  const page = allResults.slice(offset, offset + maxResults)
  const leads: SourcedLead[] = []
  let rejectedNotIcp = 0
  for (const place of page) {
    const details = await getPlaceDetails(place.place_id, apiKey); if (!details) continue
    if (failsIcpFilter(details)) { rejectedNotIcp++; continue }
    const scraped = details.website ? await scrapeSite(details.website) : { email: null, evidence: null }
    leads.push({ business_name: details.name, phone: details.formatted_phone_number ?? null, website: details.website ?? null, email: scraped.email, address: details.formatted_address ?? null, evidence: scraped.evidence })
  }
  return { leads, rejectedNotIcp, consumed: page.length, totalResults: allResults.length }
}
