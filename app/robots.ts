import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/dashboard', '/onboarding', '/connect', '/api', '/auth', '/m'],
    },
    sitemap: 'https://www.meetcaye.com/sitemap.xml',
  }
}
