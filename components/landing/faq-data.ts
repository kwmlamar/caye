// Plain data module (no 'use client') so both the server component
// (app/page.tsx, for FAQPage JSON-LD) and the client component
// (LandingPageClient.tsx, for the visible section) can import it as a
// real array. Importing a named export out of a 'use client' module
// into a server component doesn't survive the client/server boundary
// as a plain value in production builds — it broke FAQ_ITEMS.map() at
// build time when it lived inside LandingPageClient.tsx.
//
// Copy here is also what's serialized into FAQPage JSON-LD, so it's
// written as literal, factual answers (not ad copy) that hold up as
// things an AI answer engine can lift verbatim.
export const FAQ_ITEMS = [
  {
    q: 'Does Caye use my own WhatsApp number?',
    a: "Yes. Caye runs through your existing WhatsApp Business, Instagram, and Messenger accounts via Meta's Tech Provider access — there's no separate Caye-branded number for guests to learn.",
  },
  {
    q: 'Do my guests need to install an app?',
    a: 'No. Guests just message the WhatsApp number, Instagram, or Messenger account they already have. Caye answers from inside that conversation.',
  },
  {
    q: "What happens if Caye can't answer a guest's question?",
    a: "She flags it to you instead of guessing — Caye never invents a price or a policy she isn't sure of. You get pinged, you answer, she picks the conversation back up from there.",
  },
  {
    q: 'What else does Caye handle besides WhatsApp messages?',
    a: 'She quotes and books tours directly in chat, and quietly reads and writes to Zoho Mail, Gmail, and Google Calendar in the back office.',
  },
  {
    q: 'How much does Caye cost?',
    a: "It's free to try for 7 days, no credit card required. Message her on WhatsApp and she'll walk you through pricing for your business.",
  },
] as const
