import 'server-only'

/**
 * Direct durable-source retrieval.
 *
 * Anthropic exposes a server-side web_fetch tool that hands back the underlying
 * document text. OpenAI's web_search returns citations, not document bodies —
 * so for that provider Caye fetches the source itself. This is deliberately the
 * stronger option for evidence integrity: research_sources stores bytes Caye
 * actually retrieved, hashed by lib/research/runtime, rather than a model's
 * paraphrase of a page it claims to have read.
 *
 * These URLs originate from model output and are therefore untrusted. The guard
 * below refuses non-public destinations so a hallucinated or injected citation
 * cannot turn the research worker into an SSRF probe of Vercel/Supabase internals.
 */

const MAX_REDIRECTS = 3
const MAX_CONTENT_BYTES = 2_000_000
const FETCH_TIMEOUT_MS = 20_000

/**
 * Marker for "the source website failed", as opposed to "the research provider
 * failed". The router (./router.ts) must not retire a provider because someone
 * else's page 404s, so these errors are rethrown untouched instead of counting
 * against the provider's health.
 */
export const RESEARCH_SOURCE_FAILURE = 'researchSourceFailure'

function sourceError(message: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message)
  return Object.assign(error, { [RESEARCH_SOURCE_FAILURE]: true, ...extra })
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'instance-data'])
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain']

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false

  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a >= 224) return true // multicast + reserved
  return false
}

function isBlockedIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host.includes(':')) return false
  if (host === '::' || host === '::1') return true
  if (host.startsWith('fe80')) return true // link-local
  if (/^f[cd]/.test(host)) return true // unique local fc00::/7
  // IPv4-mapped addresses. WHATWG URL parsing compresses these to hex, so
  // `http://[::ffff:10.0.0.1]/` arrives as `::ffff:a00:1` — the dotted form
  // alone is not enough to catch a mapped private address.
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) return isBlockedIpv4(dotted[1])

  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const high = Number.parseInt(hex[1], 16)
    const low = Number.parseInt(hex[2], 16)
    return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }

  return false
}

/** Exported for tests: is this URL safe to retrieve as research evidence? */
export function assertPublicResearchUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw sourceError(`Research source URL is not a valid URL: ${rawUrl}`)
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw sourceError(`Research source URL must be http(s): ${rawUrl}`)
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!hostname) throw sourceError(`Research source URL has no host: ${rawUrl}`)
  if (BLOCKED_HOSTNAMES.has(hostname)) throw sourceError(`Research source URL targets a non-public host: ${hostname}`)
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw sourceError(`Research source URL targets a non-public host: ${hostname}`)
  }
  if (isBlockedIpv4(hostname) || isBlockedIpv6(url.hostname)) {
    throw sourceError(`Research source URL targets a private address: ${hostname}`)
  }

  return url
}

const BLOCK_LEVEL_TAGS = 'p|div|section|article|header|footer|li|tr|h1|h2|h3|h4|h5|h6|br|blockquote|pre'

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·',
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

/**
 * Extract readable document text from HTML. Exported for tests.
 *
 * Intentionally dependency-free: this is evidence extraction, not rendering, and
 * adding a DOM/readability dependency to the cron worker is not worth the weight.
 */
export function extractReadableText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(new RegExp(`</(?:${BLOCK_LEVEL_TAGS})\\s*>`, 'gi'), '\n')
      .replace(new RegExp(`<(?:${BLOCK_LEVEL_TAGS})(?:\\s[^>]*)?/?>`, 'gi'), '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Exported for tests: pull <title> when the search result gave us none. */
export function extractHtmlTitle(html: string): string | undefined {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const title = raw ? decodeEntities(raw).replace(/\s+/g, ' ').trim() : ''
  return title || undefined
}

/**
 * Strip characters Postgres cannot store.
 *
 * A jsonb value may not contain U+0000, and real web pages do carry stray null
 * bytes and other C0 control characters. Storing the snapshot is the step that
 * makes evidence durable, so a single bad byte must not take down a research
 * run. Tabs and newlines are kept — they carry document structure.
 */
export function sanitizeForStorage(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // Lone surrogates are equally unstorable and equally not evidence.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim()
}

export interface FetchedDocument {
  content: string
  title?: string
  finalUrl: string
  fetchedAt: string
}

/**
 * Retrieve a source document, validating every redirect hop. Returns plain text
 * suitable for storage as a durable evidence snapshot.
 */
export async function fetchResearchDocument(
  rawUrl: string,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<FetchedDocument> {
  const doFetch = deps.fetch ?? globalThis.fetch
  let current = assertPublicResearchUrl(rawUrl)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    let response: Response
    try {
      response = await doFetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Identify honestly. Caye is a research reader, not a stealth crawler.
          'user-agent': 'CayeResearch/1.0 (+https://www.meetcaye.com)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      })
    } finally {
      clearTimeout(timer)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw sourceError(`Research source redirected without a location: ${current}`)
      // Re-validate every hop; the guard is worthless if only hop 0 is checked.
      current = assertPublicResearchUrl(new URL(location, current).toString())
      continue
    }

    if (!response.ok) {
      throw sourceError(`Research source fetch failed with HTTP ${response.status}: ${current}`, { httpStatus: response.status })
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType && !/text\/html|text\/plain|application\/xhtml|application\/json|text\/xml|application\/xml/i.test(contentType)) {
      throw sourceError(`Research source is not a readable text document (${contentType}): ${current}`)
    }

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_CONTENT_BYTES) {
      throw sourceError(`Research source exceeded ${MAX_CONTENT_BYTES} bytes: ${current}`)
    }
    const body = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    const isHtml = /html|xml/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(body)
    const content = sanitizeForStorage(isHtml ? extractReadableText(body) : body.trim())

    if (!content) throw sourceError(`Research source returned no readable text: ${current}`)

    return {
      content,
      title: isHtml ? extractHtmlTitle(body) : undefined,
      finalUrl: current.toString(),
      fetchedAt: new Date().toISOString(),
    }
  }

  throw sourceError(`Research source exceeded ${MAX_REDIRECTS} redirects: ${rawUrl}`)
}
