/**
 * Google Places API for business discovery, then automated website scraping
 * for contact email extraction and a small amount of first-party evidence.
 * A website description is evidence only of what the business says it does.
 */
import 'server-only'
import { isValidOutreachEmail } from './outreach-email'

export interface PlaceResult { place_id: string; name: string }
export interface PlaceDetails { name: string; formatted_phone_number?: string; website?: string; formatted_address?: string }
export interface SourcedLead { business_name: string; phone: string | null; website: string | null; email: string | null; address: string | null; evidence: string | null }

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
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
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json'); url.searchParams.set('place_id', placeId); url.searchParams.set('fields', 'name,formatted_phone_number,website,formatted_address'); url.searchParams.set('key', apiKey)
  const data = await (await fetch(url.toString())).json(); return data.status === 'OK' ? data.result as PlaceDetails : null
}
async function scrapeSite(website: string): Promise<{ email: string | null; evidence: string | null }> {
  let candidates: string[]; try { candidates = [website, new URL('/contact', website).toString(), new URL('/contact-us', website).toString()] } catch { return { email: null, evidence: null } }
  let email: string | null = null; let evidence: string | null = null
  for (const url of candidates) {
    if (email && evidence) break
    try { const res = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (!res.ok) continue; const html = await res.text(); if (!email) email = (html.match(EMAIL_RE) ?? []).find(isLikelyRealEmail) ?? null; if (!evidence) evidence = extractEvidence(html) } catch { continue }
  }
  return { email, evidence }
}

export async function sourceLeads(query: string, location: string, maxResults: number = 20): Promise<SourcedLead[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY; if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not set')
  const leads: SourcedLead[] = []
  for (const place of (await textSearch(query, location, apiKey)).slice(0, maxResults)) {
    const details = await getPlaceDetails(place.place_id, apiKey); if (!details) continue
    const scraped = details.website ? await scrapeSite(details.website) : { email: null, evidence: null }
    leads.push({ business_name: details.name, phone: details.formatted_phone_number ?? null, website: details.website ?? null, email: scraped.email, address: details.formatted_address ?? null, evidence: scraped.evidence })
  }
  return leads
}
