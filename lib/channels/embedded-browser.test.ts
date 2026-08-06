import { describe, it, expect } from 'vitest'
import { isEmbeddedBrowser, androidIntentUrl } from './embedded-browser'

const UA = {
  androidWebView:
    'Mozilla/5.0 (Linux; Android 13; SM-A536B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  iosWkWebView:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.0.0 Mobile/15E148 Safari/604.1',
  facebookApp:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/443.0.0;]',
  instagramApp:
    'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.113',
  desktopChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
}

describe('isEmbeddedBrowser', () => {
  it('flags Android WebView, which is what a WhatsApp tap opens', () => {
    expect(isEmbeddedBrowser(UA.androidWebView)).toBe(true)
  })

  it('flags Meta in-app browsers', () => {
    expect(isEmbeddedBrowser(UA.facebookApp)).toBe(true)
    expect(isEmbeddedBrowser(UA.instagramApp)).toBe(true)
  })

  it('flags iOS WKWebView (no Safari token)', () => {
    expect(isEmbeddedBrowser(UA.iosWkWebView)).toBe(true)
  })

  it('leaves real browsers alone', () => {
    expect(isEmbeddedBrowser(UA.androidChrome)).toBe(false)
    expect(isEmbeddedBrowser(UA.iosSafari)).toBe(false)
    expect(isEmbeddedBrowser(UA.iosChrome)).toBe(false)
    expect(isEmbeddedBrowser(UA.desktopChrome)).toBe(false)
  })

  it('treats a missing User-Agent as a real browser', () => {
    // Server-to-server and odd clients shouldn't be diverted to a page
    // built for humans.
    expect(isEmbeddedBrowser(null)).toBe(false)
    expect(isEmbeddedBrowser('')).toBe(false)
  })
})

describe('androidIntentUrl', () => {
  it('preserves host, path and query', () => {
    const out = androidIntentUrl('https://www.meetcaye.com/api/auth/gmail?t=abc.def&ext=1')
    expect(out).toBe(
      'intent://www.meetcaye.com/api/auth/gmail?t=abc.def&ext=1#Intent;scheme=https;action=android.intent.action.VIEW;end'
    )
  })
})
