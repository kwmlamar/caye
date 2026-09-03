import { describe, it, expect } from 'vitest'
import {
  classifyOutreachClick,
  OUTREACH_CLICK_MIN_MS_SINCE_SEND,
  type OutreachClickRequest,
} from './outreach-click-classifier'

const REAL_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const REAL_IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const SENT_AT = '2026-09-01T12:00:00.000Z'
// Well past the too-soon-after-send window, used as a baseline "now" for
// cases not specifically testing the timing signal.
const SAFE_NOW = new Date(Date.parse(SENT_AT) + 60 * 60_000)

function baseRequest(overrides: Partial<OutreachClickRequest> = {}): OutreachClickRequest {
  return {
    method: 'GET',
    userAgent: REAL_CHROME_UA,
    firstTouchSentAt: SENT_AT,
    now: SAFE_NOW,
    ...overrides,
  }
}

describe('classifyOutreachClick — accepts real humans', () => {
  it('accepts a real desktop Chrome navigation well after send', () => {
    const result = classifyOutreachClick(baseRequest())
    expect(result).toEqual({ isLikelyHuman: true, reason: 'ok' })
  })

  it('accepts a real iPhone Safari navigation', () => {
    const result = classifyOutreachClick(baseRequest({ userAgent: REAL_IPHONE_SAFARI_UA }))
    expect(result.isLikelyHuman).toBe(true)
  })

  it('accepts real navigation Sec-Fetch-* values', () => {
    const result = classifyOutreachClick(
      baseRequest({ secFetchMode: 'navigate', secFetchDest: 'document' })
    )
    expect(result.isLikelyHuman).toBe(true)
  })

  it('accepts when firstTouchSentAt is missing (no timing signal available)', () => {
    const result = classifyOutreachClick(baseRequest({ firstTouchSentAt: null }))
    expect(result.isLikelyHuman).toBe(true)
  })

  it('accepts when Sec-Fetch-* headers are absent entirely (older/webview senders)', () => {
    const result = classifyOutreachClick(
      baseRequest({ secFetchMode: undefined, secFetchDest: undefined })
    )
    expect(result.isLikelyHuman).toBe(true)
  })
})

describe('classifyOutreachClick — rejects HEAD requests', () => {
  it('rejects HEAD even with a real browser UA', () => {
    const result = classifyOutreachClick(baseRequest({ method: 'HEAD' }))
    expect(result).toEqual({ isLikelyHuman: false, reason: 'head_request' })
  })

  it('is case-insensitive on method', () => {
    const result = classifyOutreachClick(baseRequest({ method: 'head' }))
    expect(result.reason).toBe('head_request')
  })
})

describe('classifyOutreachClick — rejects missing/empty User-Agent', () => {
  it('rejects a null UA', () => {
    const result = classifyOutreachClick(baseRequest({ userAgent: null }))
    expect(result).toEqual({ isLikelyHuman: false, reason: 'missing_user_agent' })
  })

  it('rejects an empty-string UA', () => {
    const result = classifyOutreachClick(baseRequest({ userAgent: '   ' }))
    expect(result.reason).toBe('missing_user_agent')
  })
})

describe('classifyOutreachClick — rejects known scanner/bot User-Agents', () => {
  const bots: Array<[string, string]> = [
    ['Microsoft Defender / ATP Safe Links', 'Mozilla/5.0 (compatible; ; +https://about.ads.microsoft.com/msftbot) SafeLinks/ATP'],
    ['BingPreview', 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/534+ (KHTML, like Gecko) BingPreview/1.0b'],
    ['Proofpoint', 'Proofpoint URL Defense/1.0'],
    ['Barracuda', 'Barracuda Sentinel (barracuda.com)'],
    ['Mimecast', 'Mimecast Url Protect Scanner'],
    ['Symantec', 'Symantec MessageLabs Anti-Virus'],
    ['Slackbot', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
    ['facebookexternalhit', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
    ['curl', 'curl/8.4.0'],
    ['python-requests', 'python-requests/2.31.0'],
    ['Go-http-client', 'Go-http-client/1.1'],
    ['GoogleBot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['generic bot token', 'Mozilla/5.0 (compatible; SomeCorpScannerBot/2.0)'],
    ['headless marker', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36'],
  ]

  it.each(bots)('rejects %s', (_label, ua) => {
    const result = classifyOutreachClick(baseRequest({ userAgent: ua }))
    expect(result.isLikelyHuman).toBe(false)
    expect(['known_bot_user_agent', 'no_positive_browser_signal']).toContain(result.reason)
  })

  it('rejects a bare/spoofed UA with no real engine token', () => {
    const result = classifyOutreachClick(baseRequest({ userAgent: 'Mozilla/5.0' }))
    expect(result).toEqual({ isLikelyHuman: false, reason: 'no_positive_browser_signal' })
  })
})

describe('classifyOutreachClick — rejects prefetch/preview signaling headers', () => {
  it('rejects Purpose: prefetch', () => {
    const result = classifyOutreachClick(baseRequest({ purpose: 'prefetch' }))
    expect(result).toEqual({ isLikelyHuman: false, reason: 'prefetch_header' })
  })

  it('rejects Sec-Purpose: prefetch;prerender', () => {
    const result = classifyOutreachClick(baseRequest({ secPurpose: 'prefetch;prerender' }))
    expect(result.reason).toBe('prefetch_header')
  })

  it('rejects X-Purpose: preview', () => {
    const result = classifyOutreachClick(baseRequest({ xPurpose: 'preview' }))
    expect(result.reason).toBe('prefetch_header')
  })

  it('rejects X-Moz: prefetch', () => {
    const result = classifyOutreachClick(baseRequest({ xMoz: 'prefetch' }))
    expect(result.reason).toBe('prefetch_header')
  })
})

describe('classifyOutreachClick — rejects background Sec-Fetch-* values', () => {
  it('rejects Sec-Fetch-Mode: cors (background fetch, not navigation)', () => {
    const result = classifyOutreachClick(baseRequest({ secFetchMode: 'cors' }))
    expect(result).toEqual({ isLikelyHuman: false, reason: 'background_fetch_mode' })
  })

  it('rejects Sec-Fetch-Dest: empty (background fetch, not a document load)', () => {
    const result = classifyOutreachClick(baseRequest({ secFetchDest: 'empty' }))
    expect(result).toEqual({ isLikelyHuman: false, reason: 'background_fetch_dest' })
  })
})

describe('classifyOutreachClick — rejects hits too soon after send', () => {
  it('rejects a hit in the same second as send (the classic scanner signature)', () => {
    const result = classifyOutreachClick(
      baseRequest({ now: new Date(Date.parse(SENT_AT) + 500) })
    )
    expect(result).toEqual({ isLikelyHuman: false, reason: 'too_soon_after_send' })
  })

  it('rejects a hit right at the threshold boundary', () => {
    const result = classifyOutreachClick(
      baseRequest({ now: new Date(Date.parse(SENT_AT) + OUTREACH_CLICK_MIN_MS_SINCE_SEND - 1) })
    )
    expect(result.reason).toBe('too_soon_after_send')
  })

  it('accepts a hit exactly at the threshold', () => {
    const result = classifyOutreachClick(
      baseRequest({ now: new Date(Date.parse(SENT_AT) + OUTREACH_CLICK_MIN_MS_SINCE_SEND) })
    )
    expect(result.isLikelyHuman).toBe(true)
  })

  it('ignores an unparsable firstTouchSentAt rather than rejecting', () => {
    const result = classifyOutreachClick(baseRequest({ firstTouchSentAt: 'not-a-date' }))
    expect(result.isLikelyHuman).toBe(true)
  })
})
