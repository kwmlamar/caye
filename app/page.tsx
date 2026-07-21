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
  title: 'Caye — Your AI Front Desk for WhatsApp',
  description:
    'Caye is a WhatsApp-first AI staff member for tour operators. She answers guest DMs, quotes tours, and books them — live on WhatsApp, Instagram, and Messenger. Free for 7 days, no credit card.',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: 'Caye — Your AI Front Desk for WhatsApp',
    description:
      'She answers, quotes, and books. The AI staff member that lives in your WhatsApp — built for tour operators.',
    url: '/',
    siteName: 'Caye',
    images: [{ url: '/hero.png', width: 1980, height: 1114, alt: 'Caye answering a guest on WhatsApp' }],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Caye — Your AI Front Desk for WhatsApp',
    description:
      'She answers, quotes, and books. The AI staff member that lives in your WhatsApp — built for tour operators.',
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
        'Caye is a WhatsApp-first AI staff member for tour operators, built by TropiTech Solutions.',
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
