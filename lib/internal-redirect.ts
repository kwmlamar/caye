const APPLICATION_ORIGIN = 'https://caye.invalid'

/** Accept only a same-origin absolute path when preserving a post-login return URL. */
export function internalRedirectPath(value: string | null): string | null {
  if (!value?.startsWith('/') || value.startsWith('//')) return null
  try {
    const url = new URL(value, APPLICATION_ORIGIN)
    return url.origin === APPLICATION_ORIGIN ? `${url.pathname}${url.search}${url.hash}` : null
  } catch {
    return null
  }
}
