import type { Metadata } from 'next'
import LandingPageClient from '@/components/landing/LandingPageClient'
import { FAQ_ITEMS } from '@/components/landing/faq-data'

// Metadata has to live in a server component — the landing page itself
// is 'use client' (mesh-gradient hero, scroll reveals), so the actual
// markup lives in LandingPageClient and this file just wraps it with
// the stuff that requires a server component: <head> metadata + the
// JSON-LD block search engines and AI answer engines read to figure out
// what Caye is without having to infer it from the hero copy.
export const metadata: Metadata = {
  title: 'Caye — Not a Tool. A Hire for Your Front Desk.',
  description:
    'Caye is a hire, not software — you text her like staff, with no dashboard, login, or settings page. She answers guest messages, quotes tours, and books them across WhatsApp, Instagram, and Messenger for Caribbean tour operators. Free for 7 days, no credit card.',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: 'Caye — Not a Tool. A Hire for Your Front Desk.',
    description:
      'You text her like staff — no dashboard, no login, no settings page. She answers, quotes, and books for Caribbean tour operators.',
    url: '/',
    siteName: 'Caye',
    images: [{ url: '/hero.png', width: 1980, height: 1114, alt: 'Caye answering a guest on WhatsApp' }],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Caye — Not a Tool. A Hire for Your Front Desk.',
    description:
      'You text her like staff — no dashboard, no login, no settings page. She answers, quotes, and books for Caribbean tour operators.',
    images: ['/hero.png'],
  },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      name: 'Caye',
      url: 'https://www.meetcaye.com',
      logo: 'https://www.meetcaye.com/caye-mark-1024.png',
      description:
        'Caye is a hire for Caribbean tour operators, built by TropiTech Solutions — you manage her like staff, with no dashboard or software to configure.',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'Caye',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web, WhatsApp',
      description:
        'Caye answers guest messages, quotes tours, and books them for tour operators — live on WhatsApp, Instagram, and Messenger. No app for guests to install.',
    },
    {
      '@type': 'FAQPage',
      mainEntity: FAQ_ITEMS.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.a,
        },
      })),
    },
  ],
}

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LandingPageClient />
    </>
  )
}
