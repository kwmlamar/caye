import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Caye — AI Receptionist',
    short_name: 'Caye',
    description: 'Your Caribbean AI receptionist. See what Caye handled, review what she held.',
    start_url: '/login',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f5f1e8',
    theme_color: '#1d6b5e',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
