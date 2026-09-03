/**
 * Pure classifier for app/api/r/[token]/route.ts — decides whether a hit on
 * the tracked cold-outreach demo link is plausibly a human clicking through,
 * as opposed to a mail security scanner / link-preview prefetcher / bot.
 *
 * Why this exists: production evidence (2026-09-03) showed outreach_leads
 * .tried_at was measuring email security scanners, not people — 16 leads
 * marked 'tried', zero real demo conversations, 9/16 stamped the same day
 * as send (the signature of a mail gateway prefetching links on delivery),
 * several on corporate hosts (titan.bs, atlantisparadise.com) known to run
 * link scanners. See CAY outreach-tried-signal-integrity for the full
 * writeup.
 *
 * Deliberately conservative in ONE direction only: it is far worse to
 * record a scanner hit as a demo-engaged lead (poisons the founder's
 * dashboard, the morning digest, and lib/direction/outcome-read-model.ts's
 * funnel metrics with fiction) than to fail to record a genuine human click
 * (worst case, a real prospect's engagement goes unrecorded — recoverable
 * via a confirmed-demo signal later, see lib/outreach-click-demo-
 * confirmation.ts). So this classifier requires a POSITIVE signal that the
 * request looks like a real browser's top-level navigation, not merely the
 * absence of an obviously-bad one — a rejects-by-default posture.
 *
 * No network calls here. Pure function of request-derived strings, so it
 * stays fast on the redirect hot path and is trivially unit-testable.
 */

export interface OutreachClickRequest {
  /** HTTP method of the hit. A HEAD request is never a human clicking. */
  method: string
  userAgent: string | null | undefined
  /** `Purpose` header — Chrome/Firefox prefetch/prerender signal. */
  purpose?: string | null
  /** `Sec-Purpose` header — modern replacement for `Purpose`. */
  secPurpose?: string | null
  /** `X-Purpose` header — some proxies/scanners use this non-standard name. */
  xPurpose?: string | null
  /** `X-Moz` header — legacy Firefox prefetch signal (`X-Moz: prefetch`). */
  xMoz?: string | null
  /** `Sec-Fetch-Mode` — real top-level navigation sends `navigate`. */
  secFetchMode?: string | null
  /** `Sec-Fetch-Dest` — real top-level navigation sends `document`. */
  secFetchDest?: string | null
  /** ISO timestamp the tracked email was sent (outreach_leads.first_touch_sent_at). */
  firstTouchSentAt?: string | null
  /** Injectable for tests; defaults to `new Date()`. */
  now?: Date
}

export type OutreachClickRejectReason =
  | 'head_request'
  | 'missing_user_agent'
  | 'known_bot_user_agent'
  | 'no_positive_browser_signal'
  | 'prefetch_header'
  | 'background_fetch_mode'
  | 'background_fetch_dest'
  | 'too_soon_after_send'

export interface OutreachClickClassification {
  isLikelyHuman: boolean
  /** 'ok' when accepted, else the single deciding reject reason. */
  reason: OutreachClickRejectReason | 'ok'
}

/**
 * A hit inside this many milliseconds of the tracked email being sent is
 * treated as a scanner, not a reader. Mail security gateways (Defender/
 * ATP Safe Links, Proofpoint, Mimecast, Barracuda...) fetch every link in
 * an email within seconds of delivery, before the recipient has even seen
 * it land. No cold-outreach recipient authentically reads a subject line,
 * opens the email, and decides to click within half a minute of it
 * arriving — real engagement takes at least that long even for a fast
 * reader who already had their inbox open. 30s is intentionally short
 * (favors NOT rejecting a real click) since this is only one of several
 * independent signals, not the sole gate.
 */
export const OUTREACH_CLICK_MIN_MS_SINCE_SEND = 30_000

// Known scanner / prefetcher / bot / HTTP-library User-Agent substrings.
// Matched case-insensitively against the full UA string. Deliberately
// broad — a false-positive here just means one fewer recorded "tried",
// which is the safe direction to err in (see module docstring).
const BOT_UA_PATTERNS: RegExp[] = [
  // Generic crawler/bot self-identification. Deliberately no word
  // boundary — "SomeCorpScannerBot" and "Googlebot" both self-identify
  // with "bot" glued onto another word, not as a standalone token.
  /bot/i,
  /spider/i,
  /crawler/i,
  /slurp/i,
  /headless/i,
  /phantomjs/i,
  /puppeteer/i,
  /playwright/i,
  /selenium/i,
  // Social / chat link-preview fetchers.
  /facebookexternalhit/i,
  /facebookcatalog/i,
  /slackbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /discordbot/i,
  /bingpreview/i,
  // Corporate mail security scanners / Safe Links — the exact culprits
  // named in the production evidence (titan.bs, atlantisparadise.com).
  /proofpoint/i,
  /mimecast/i,
  /barracuda/i,
  /symantec/i,
  /messagelabs/i,
  /forcepoint/i,
  /trendmicro/i,
  /fireeye/i,
  /defender/i,
  /safelinks/i,
  /\batp\b/i,
  // Generic HTTP client / scripting libraries — never a browser.
  /curl\//i,
  /wget\//i,
  /python-requests/i,
  /python-urllib/i,
  /go-http-client/i,
  /okhttp/i,
  /axios\//i,
  /node-fetch/i,
  /postmanruntime/i,
  /guzzlehttp/i,
  /^java\//i,
  /libwww-perl/i,
  // Search-engine / SEO crawlers.
  /googlebot/i,
  /google-?safety/i,
  /googleimageproxy/i,
  /yandexbot/i,
  /duckduckbot/i,
  /ahrefsbot/i,
  /semrushbot/i,
  /mj12bot/i,
  /applebot/i,
]

// A real desktop/mobile browser rendering a top-level navigation. Requires
// the standard Mozilla/5.0 prefix AND a real engine token — cheap UA
// spoofing that copies "Mozilla/5.0" alone (common in unsophisticated
// scanners) without an engine token still fails this.
const REAL_BROWSER_UA_RE = /Mozilla\/5\.0/i
const REAL_ENGINE_TOKEN_RE = /(AppleWebKit|Gecko)\//i

function isKnownBotUserAgent(ua: string): boolean {
  return BOT_UA_PATTERNS.some((re) => re.test(ua))
}

function looksLikeRealBrowser(ua: string): boolean {
  return REAL_BROWSER_UA_RE.test(ua) && REAL_ENGINE_TOKEN_RE.test(ua)
}

function isPrefetchHeaderValue(value: string | null | undefined): boolean {
  if (!value) return false
  return /prefetch|prerender|preview/i.test(value)
}

export function classifyOutreachClick(req: OutreachClickRequest): OutreachClickClassification {
  if (req.method.toUpperCase() === 'HEAD') {
    return { isLikelyHuman: false, reason: 'head_request' }
  }

  const ua = (req.userAgent ?? '').trim()
  if (!ua) {
    return { isLikelyHuman: false, reason: 'missing_user_agent' }
  }
  if (isKnownBotUserAgent(ua)) {
    return { isLikelyHuman: false, reason: 'known_bot_user_agent' }
  }
  if (!looksLikeRealBrowser(ua)) {
    return { isLikelyHuman: false, reason: 'no_positive_browser_signal' }
  }

  if (
    isPrefetchHeaderValue(req.purpose) ||
    isPrefetchHeaderValue(req.secPurpose) ||
    isPrefetchHeaderValue(req.xPurpose) ||
    isPrefetchHeaderValue(req.xMoz)
  ) {
    return { isLikelyHuman: false, reason: 'prefetch_header' }
  }

  // Sec-Fetch-* are opt-in browser signals — many legitimate senders
  // (older browsers, some in-app mail-client webviews) omit them
  // entirely, so absence is neutral. Presence with a non-navigation
  // value is a hard tell of a background fetch, though.
  if (req.secFetchMode && req.secFetchMode.toLowerCase() !== 'navigate') {
    return { isLikelyHuman: false, reason: 'background_fetch_mode' }
  }
  if (req.secFetchDest && req.secFetchDest.toLowerCase() !== 'document') {
    return { isLikelyHuman: false, reason: 'background_fetch_dest' }
  }

  if (req.firstTouchSentAt) {
    const sentAt = Date.parse(req.firstTouchSentAt)
    if (!Number.isNaN(sentAt)) {
      const now = (req.now ?? new Date()).getTime()
      if (now - sentAt < OUTREACH_CLICK_MIN_MS_SINCE_SEND) {
        return { isLikelyHuman: false, reason: 'too_soon_after_send' }
      }
    }
  }

  return { isLikelyHuman: true, reason: 'ok' }
}
