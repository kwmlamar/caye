/**
 * Google Places API for business discovery, then automated website
 * scraping for email extraction. Extracted from scripts/source-leads.ts
 * (2026-07-29) so app/api/caye/outreach-sourcing-scan can call the same
 * logic on a schedule — the CLI script now just wraps this for ad-hoc
 * manual runs.
 *
 * Two-stage because Places API doesn't return emails (only name, phone,
 * website, address). No Hunter.io/Clearbit key is configured in this repo,
 * so this scrapes each business's own site for a contact email instead of
 * calling a paid enrichment API. Known ceiling: Cloudflare-obfuscated or
 * JS-rendered emails won't be found this way — same limit manual web
 * search hit all week (see decisions-log 2026-07-29).
 *
 * The same site fetch also pulls a meta/og description when one exists
 * (`evidence` on SourcedLead) — real, business-authored text the first-touch
 * draft can personalize its HOOK beat from, instead of that beat having
 * nothing to work with beyond a name and an industry guess.
 */
import 'server-only'
import { isValidOutreachEmail } from './outreach-email'

export interface PlaceResult {
  place_id: string
  name: string
}

export interface PlaceDetails {
  name: string
  formatted_phone_number?: string
  website?: string
  formatted_address?: string
}

export interface SourcedLead {
  business_name: string
  phone: string | null
  website: string | null
  email: string | null
  address: string | null
  /**
   * A short excerpt (meta/og description) scraped from the business's own
   * site, if one was found. Real observed evidence for the first-touch
   * HOOK beat to personalize from — see lib/sales/voice.ts — instead of
   * that beat having nothing to work with but a name and a category.
   */
  evidence: string | null
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const META_DESCRIPTION_RE = /<meta\s+(?:[^>]*?\s)?name=["']description["'][^>]*?content=["']([^"']+)["']/i
const OG_DESCRIPTION_RE = /<meta\s+(?:[^>]*?\s)?property=["']og:description["'][^>]*?content=["']([^"']+)["']/i
const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d+|[a-z]+);?/gi, (whole, code) => {
    if (code.startsWith('#')) {
      const num = Number(code.slice(1))
      return Number.isFinite(num) ? String.fromCharCode(num) : whole
    }
    return HTML_ENTITIES[code.toLowerCase()] ?? whole
  })
}

const MAX_EVIDENCE_LENGTH = 300
const MIN_EVIDENCE_LENGTH = 20

/**
 * A page's own meta/og description, if present — chosen over scraping
 * visible body text because it is structured and business-authored
 * (nav menus, cookie banners, and template boilerplate cannot leak in the
 * way they would from a naive text dump). Returns null far more often than
 * not; callers must treat that as the common case, not an error.
 */
function extractEvidence(html: string): string | null {
  const match = html.match(META_DESCRIPTION_RE) ?? html.match(OG_DESCRIPTION_RE)
  if (!match) return null
  const text = decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim()
  if (text.length < MIN_EVIDENCE_LENGTH) return null
  return text.length > MAX_EVIDENCE_LENGTH ? `${text.slice(0, MAX_EVIDENCE_LENGTH).trim()}…` : text
}

// Patterns that are never a real contact address. Two categories:
// (1) schema.org boilerplate, image filenames caught by the regex, platform
//     noise (Wix/Sentry/GoDaddy), W3C spec examples on template sites;
// (2) third-party booking-widget SaaS support addresses embedded on a small
//     operator's site (FareHarbor, Peek, Bokun, Checkfront) — confirmed live
//     2026-07-29: a Cartagena boat operator's site returned
//     support@fareharbor.com, FareHarbor's own support inbox, not the
//     operator's — these platforms are common enough among tour operators
//     that this needs to stay a permanent filter, not a one-off fix.
const EMAIL_BLOCKLIST_PATTERNS = [
  /\.(png|jpe?g|gif|svg|webp)$/i,
  /sentry\.io$/i,
  /wixpress\.com$/i,
  /schema\.org$/i,
  /example\.com$/i,
  /godaddy\.com$/i,
  /w3\.org$/i,
  /\.wixsite\.com$/i,
  /fareharbor\.com$/i,
  /peek\.com$/i,
  /bokun\.io$/i,
  /checkfront\.com$/i,
  /rezdy\.com$/i,
  /^user@domain\.com$/i,
  /^(name|email|test|someone|yourname)@(domain|example|yoursite)\.com$/i,
  // Shared web-developer/agency contact — confirmed appearing on two
  // unrelated businesses' sites (a Tulum villa and a Puerto Rico fishing
  // charter, 2026-07-30), same pattern as the booking-platform false
  // positives: it's whoever built the site, not the business itself.
  /eyebytes\.com$/i,
]

function isLikelyRealEmail(email: string): boolean {
  const lower = email.toLowerCase()
  return isValidOutreachEmail(email) && !EMAIL_BLOCKLIST_PATTERNS.some((re) => re.test(lower))
}

async function textSearch(query: string, location: string, apiKey: string): Promise<PlaceResult[]> {
  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json')
  url.searchParams.set('query', `${query} in ${location}`)
  url.searchParams.set('key', apiKey)

  const results: PlaceResult[] = []
  let pageUrl: string | null = url.toString()

  // Places Text Search caps at 60 results (3 pages of 20) regardless of
  // how many more might exist — a hard API limit, not a choice made here.
  while (pageUrl && results.length < 60) {
    const res: Response = await fetch(pageUrl)
    const data = await res.json()
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error(`Places API error: ${data.status} — ${data.error_message ?? ''}`)
      break
    }
    results.push(...(data.results ?? []))

    if (data.next_page_token) {
      // Google requires a short delay before a next_page_token becomes valid.
      await new Promise((r) => setTimeout(r, 2000))
      const nextUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json')
      nextUrl.searchParams.set('pagetoken', data.next_page_token)
      nextUrl.searchParams.set('key', apiKey)
      pageUrl = nextUrl.toString()
    } else {
      pageUrl = null
    }
  }

  return results
}

async function getPlaceDetails(placeId: string, apiKey: string): Promise<PlaceDetails | null> {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json')
  url.searchParams.set('place_id', placeId)
  url.searchParams.set('fields', 'name,formatted_phone_number,website,formatted_address')
  url.searchParams.set('key', apiKey)

  const res = await fetch(url.toString())
  const data = await res.json()
  if (data.status !== 'OK') return null
  return data.result as PlaceDetails
}

interface SiteScrapeResult {
  email: string | null
  evidence: string | null
}

/**
 * Visits the same candidate pages already fetched for email extraction and
 * pulls a description out of whichever one responds first — no extra
 * network calls beyond what this function already made before evidence
 * capture existed. Keeps scanning candidates until both an email and an
 * evidence excerpt are found or the candidates run out, since the email
 * and the description are not reliably on the same page (a /contact page
 * often has an address form and no description tag at all).
 */
async function scrapeSite(website: string): Promise<SiteScrapeResult> {
  let candidates: string[]
  try {
    candidates = [website, new URL('/contact', website).toString(), new URL('/contact-us', website).toString()]
  } catch {
    return { email: null, evidence: null }
  }

  let email: string | null = null
  let evidence: string | null = null

  for (const url of candidates) {
    if (email && evidence) break
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const html = await res.text()
      if (!email) {
        const matches = html.match(EMAIL_RE) ?? []
        email = matches.find(isLikelyRealEmail) ?? null
      }
      if (!evidence) evidence = extractEvidence(html)
    } catch {
      // Unreachable site, timeout, DNS failure, or an invalid contact-page
      // guess — expected for a real fraction of listings, move on.
      continue
    }
  }
  return { email, evidence }
}

/**
 * Searches Places for `query` (a vertical, e.g. "tour operator") in
 * `location` (a region, e.g. "Nassau, Bahamas"), then scrapes each result's
 * own website for a contact email. Returns only leads a caller still has to
 * filter for a found email — callers that only want emailable leads should
 * filter on `.email` themselves (see outreach-sourcing-scan's usage).
 */
export async function sourceLeads(
  query: string,
  location: string,
  maxResults: number = 20
): Promise<SourcedLead[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not set')

  const places = await textSearch(query, location, apiKey)
  const leads: SourcedLead[] = []

  for (const place of places.slice(0, maxResults)) {
    const details = await getPlaceDetails(place.place_id, apiKey)
    if (!details) continue

    const { email, evidence } = details.website ? await scrapeSite(details.website) : { email: null, evidence: null }

    leads.push({
      business_name: details.name,
      phone: details.formatted_phone_number ?? null,
      website: details.website ?? null,
      email,
      address: details.formatted_address ?? null,
      evidence,
    })
  }

  return leads
}
