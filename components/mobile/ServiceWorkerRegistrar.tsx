'use client'

import { useEffect } from 'react'

/**
 * Registers the Caye service worker so the mobile app is installable
 * as a PWA. Renders nothing. Safe to mount once in the mobile layout.
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((err) => console.warn('[Caye PWA] Service worker registration failed:', err))
    }

    if (document.readyState === 'complete') register()
    else {
      window.addEventListener('load', register)
      return () => window.removeEventListener('load', register)
    }
  }, [])

  return null
}
