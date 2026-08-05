/**
 * Bulk lead sourcing: Google Places API for business discovery, then
 * automated website scraping for email extraction.
 *
 * Two-stage because Places API doesn't return emails (only name, phone,
 * website, address). No Hunter.io/Clearbit key is configured in this repo,
 * so this scrapes each business's own site for a contact email instead of
 * calling a paid enrichment API. Known ceiling: Cloudflare-obfuscated or
 * JS-rendered emails won't be found this way — same limit manual web
 * search hit all week (see decisions-log 2026-07-29).
 *
 * Usage (dotenv isn't installed in this repo — source env vars directly):
 *   set -a && source .env.local && set +a && npx tsx scripts/source-leads.ts "<query>" "<location>" [maxResults]
 *
 * Example:
 *   npx tsx scripts/source-leads.ts "boat tour" "Cartagena, Colombia" 20
 *
 * Prints progress to stderr, and the final JSON array of leads to stdout
 * (so `> leads.json` redirection captures clean data without the log noise).
 */

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY
if (!GOOGLE_MAPS_API_KEY) {
  console.error('GOOGLE_MAPS_API_KEY not set — source .env.local first')
  process.exit(1)
}

interface PlaceResult {
  place_id: string
  name: string
}

interface PlaceDetails {
  name: string
  formatted_phone_number?: string
  website?: string
  formatted_address?: string
}

interface Lead {
  business_name: string
  phone: string | null
  website: string | null
  email: string | null
  address: string | null
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

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
]

function isLikelyRealEmail(email: string): boolean {
  const lower = email.toLowerCase()
  return !EMAIL_BLOCKLIST_PATTERNS.some((re) => re.test(lower))
}

async function textSearch(query: string, location: string): Promise<PlaceResult[]> {
  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json')
  url.searchParams.set('query', `${query} in ${location}`)
  url.searchParams.set('key', GOOGLE_MAPS_API_KEY!)

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
      nextUrl.searchParams.set('key', GOOGLE_MAPS_API_KEY!)
      pageUrl = nextUrl.toString()
    } else {
      pageUrl = null
    }
  }

  return results
}

async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json')
  url.searchParams.set('place_id', placeId)
  url.searchParams.set('fields', 'name,formatted_phone_number,website,formatted_address')
  url.searchParams.set('key', GOOGLE_MAPS_API_KEY!)

  const res = await fetch(url.toString())
  const data = await res.json()
  if (data.status !== 'OK') return null
  return data.result as PlaceDetails
}

async function findEmailOnSite(website: string): Promise<string | null> {
  let candidates: string[]
  try {
    candidates = [website, new URL('/contact', website).toString(), new URL('/contact-us', website).toString()]
  } catch {
    return null
  }

  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const html = await res.text()
      const matches = html.match(EMAIL_RE) ?? []
      const real = matches.find(isLikelyRealEmail)
      if (real) return real
    } catch {
      // Unreachable site, timeout, DNS failure, or an invalid contact-page
      // guess — expected for a real fraction of listings, move on.
      continue
    }
  }
  return null
}

async function main() {
  const [query, location, maxArg] = process.argv.slice(2)
  if (!query || !location) {
    console.error('Usage: npx tsx scripts/source-leads.ts "<query>" "<location>" [maxResults]')
    process.exit(1)
  }
  const maxResults = maxArg ? parseInt(maxArg, 10) : 20

  console.error(`Searching Places API: "${query}" in "${location}"...`)
  const places = await textSearch(query, location)
  console.error(`Found ${places.length} places. Fetching details + scraping emails for up to ${maxResults}...`)

  const leads: Lead[] = []
  for (const place of places.slice(0, maxResults)) {
    const details = await getPlaceDetails(place.place_id)
    if (!details) continue

    const email = details.website ? await findEmailOnSite(details.website) : null

    leads.push({
      business_name: details.name,
      phone: details.formatted_phone_number ?? null,
      website: details.website ?? null,
      email,
      address: details.formatted_address ?? null,
    })

    console.error(`  ${details.name} — ${email ?? '(no email found)'}`)
  }

  const withEmail = leads.filter((l) => l.email)
  console.error(`\nDone: ${leads.length} businesses processed, ${withEmail.length} with a found email.`)
  console.log(JSON.stringify(leads, null, 2))
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
