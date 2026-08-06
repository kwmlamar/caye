/**
 * Detects in-app / embedded browsers, which matter because Google refuses
 * OAuth inside them (`disallowed_useragent`) as a matter of policy.
 *
 * Caye texts connect links, so the overwhelmingly common case is a tap
 * from inside WhatsApp — and on Android that opens a WebView. Rather than
 * making everyone pay an "open in your browser" step, the OAuth initiators
 * check this and only divert the requests that would otherwise dead-end at
 * a Google error page.
 *
 * Deliberately no 'server-only': it's pure string matching over a
 * User-Agent and is unit-tested directly.
 *
 * Erring toward false positives is the right bias here. A false positive
 * costs one extra tap on an interstitial; a false negative is a dead end
 * on a provider error screen the user cannot get past, at the exact moment
 * they're trying to activate.
 */

/** Explicit in-app browser markers, most reliable first. */
const EMBEDDED_MARKERS = [
  /;\s*wv[;)]/i, // Android WebView's own flag — the canonical signal
  /\bFBAN\/|\bFBAV\/|\bFB_IAB\//i, // Facebook / Messenger in-app
  /\bInstagram\b/i,
  /\bLine\//i,
  /\bMicroMessenger\b/i, // WeChat
  /\bWhatsApp\//i,
]

export function isEmbeddedBrowser(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  const ua = userAgent.trim()
  if (!ua) return false

  if (EMBEDDED_MARKERS.some((re) => re.test(ua))) return true

  // iOS in-app browsers built on WKWebView report an iOS UA but omit the
  // "Safari/" token that real Safari always carries. (SFSafariViewController
  // does include it, and Google accepts it — so this correctly leaves that
  // case alone.) Chrome/Firefox/Edge on iOS carry their own tokens and are
  // real browsers, so exclude them before applying the rule.
  const isIOS = /\b(iPhone|iPad|iPod)\b/.test(ua)
  const isIOSRealBrowser = /\b(CriOS|FxiOS|EdgiOS|OPiOS)\//.test(ua)
  if (isIOS && !isIOSRealBrowser && !/\bSafari\//.test(ua)) return true

  return false
}

/**
 * Android hands `intent://` URLs off to the system, which opens them in
 * the user's default browser — the reliable way out of a WebView. No
 * package is pinned: forcing com.android.chrome fails outright on a phone
 * without Chrome, and the default handler is what we actually want.
 */
export function androidIntentUrl(httpsUrl: string): string {
  const url = new URL(httpsUrl)
  const rest = `${url.host}${url.pathname}${url.search}`
  return `intent://${rest}#Intent;scheme=https;action=android.intent.action.VIEW;end`
}
