/**
 * Caye service worker — minimal, hand-rolled (no next-pwa dependency).
 *
 * Scope: just enough to make the app installable as a PWA and survive
 * brief offline blips on the app shell. It deliberately does NOT cache
 * API responses or Supabase calls — the operator always wants live data.
 *
 * Push handling is wired but inert until a push subscription exists.
 */

const CACHE = 'caye-shell-v1'
const SHELL = ['/', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  // Never cache API / auth / Supabase traffic — always go to network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return
  if (url.origin !== self.location.origin) return

  // Network-first for navigations, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/').then((r) => r || Response.error()))
    )
    return
  }

  // Cache-first for static assets in the shell.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  )
})

// ── Push (inert until a subscription is registered) ──────────────────────────
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Caye', body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Caye'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow(target)
    })
  )
})
