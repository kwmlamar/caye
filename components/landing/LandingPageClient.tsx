'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import {
  WhatsappLogoIcon,
  ListIcon,
  XIcon,
  ClockCountdownIcon,
  CalendarCheckIcon,
  InstagramLogoIcon,
  MessengerLogoIcon,
  EnvelopeSimpleIcon,
  CalendarBlankIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  ChatCircleDotsIcon,
  UsersIcon,
  CalendarIcon,
  CreditCardIcon,
  ChartBarIcon,
  GearSixIcon,
  LightningIcon,
  TrendUpIcon,
  ShieldCheckIcon,
  LockIcon,
  CheckCircleIcon,
  WifiHighIcon,
  CheckIcon,
} from '@phosphor-icons/react'
import { sendGAEvent } from '@next/third-parties/google'
import { FAQ_ITEMS } from '@/components/landing/faq-data'

// Six-card ring around the hero orb — mirrors the mockup's
// "Communicates / Follows Up / Manages / Processes / Reports /
// Automates" grid. Odd-index cards render in the left column, even in
// the right, matching the reference layout (3 + 3 flanking the orb).
const HERO_FEATURE_CARDS = [
  { title: 'Communicates', desc: 'Handles chats, calls, emails & DMs', Icon: ChatCircleDotsIcon },
  { title: 'Follows Up', desc: 'Nurtures leads & past customers', Icon: UsersIcon },
  { title: 'Manages', desc: 'Schedules, reminders, appointments', Icon: CalendarIcon },
  { title: 'Processes', desc: 'Payments, invoices & confirmations', Icon: CreditCardIcon },
  { title: 'Reports', desc: 'Insights, metrics, weekly summaries', Icon: ChartBarIcon },
  { title: 'Automates', desc: 'Workflows, tasks & daily operations', Icon: GearSixIcon },
] as const

// Four stat tiles inside the "Everything. Everywhere. Handled." panel.
const HERO_STAT_ITEMS = [
  { title: 'Saves time', desc: 'We handle the busywork', Icon: LightningIcon, badge: null },
  { title: 'Increases revenue', desc: 'More leads. More bookings. More sales.', Icon: TrendUpIcon, badge: null },
  { title: 'Reduces costs', desc: 'One employee. Unlimited value.', Icon: ShieldCheckIcon, badge: null },
  { title: 'Works 24/7', desc: 'Never calls out. Never sleeps.', Icon: null, badge: '24/7' },
] as const

// Trust-badge row under the stat panel.
const TRUST_BADGES = [
  { label: 'Secure', Icon: ShieldCheckIcon },
  { label: 'Private', Icon: LockIcon },
  { label: 'Reliable', Icon: CheckCircleIcon },
  { label: 'Always On', Icon: WifiHighIcon },
] as const

// Fires whenever a visitor clicks through to the WhatsApp signup — the
// only real conversion action on this page. Named `qualify_lead` (not
// something WhatsApp-specific) to match the Key Event already configured
// in GA4 — it was starred as a key event with no code ever sending it.
// `location` marks which of the five CTA instances (nav, mobile menu,
// hero, mid-page, footer) so GA can tell which placement converts.
function trackSignupClick(location: string) {
  sendGAEvent('event', 'qualify_lead', { location })
}

// Simplified landing — credibility surface, not a conversion engine.
// Primary CTA goes straight to a demo request (lamar@tropitech.org).
// Self-serve signup is quiet in the footer until embedded-signup ships.
//
// Typography:
//   Headline   — Instrument Serif (editorial display, italic accent)
//   Subhead    — Newsreader light (editorial deck/subtitle, pairs with Instrument)
//   Eyebrow    — JetBrains Mono uppercase (editorial dateline)
//   Body / nav — Geist (sans, product-UI default)

// Signup is WhatsApp-first — no web form. Same wa.me pattern as
// app/onboarding/OnboardingClient.tsx and app/signup/page.tsx.
const CAYE_SIGNUP_WA_HREF = process.env.NEXT_PUBLIC_CAYE_WHATSAPP_NUMBER
  ? `https://wa.me/${process.env.NEXT_PUBLIC_CAYE_WHATSAPP_NUMBER}?text=${encodeURIComponent("Hi Caye! I'd like to sign up.")}`
  : '/signup'

// Footer link columns — only real destinations (no fabricated Blog/
// Careers/Pricing pages the way Viktor's footer has; Caye doesn't have
// those yet). #channels is an in-page anchor on this file.
const FOOTER_COLUMNS: {
  title: string
  links: { label: string; href: string; external?: boolean }[]
}[] = [
    {
      title: 'Product',
      links: [
        { label: 'Try Caye free', href: CAYE_SIGNUP_WA_HREF, external: true },
        { label: 'Log in', href: '/login' },
        { label: 'How she works', href: '#channels' },
      ],
    },
    {
      title: 'Company',
      links: [
        { label: 'Contact', href: 'mailto:lamar@tropitech.org?subject=Caye' },
      ],
    },
    {
      title: 'Legal',
      links: [
        { label: 'Terms', href: '/terms' },
        { label: 'Privacy', href: '/privacy' },
        { label: 'Data deletion', href: '/data-deletion' },
      ],
    },
  ]

// Ask-AI banner — the beat Viktor uses right before its FAQ: invite
// visitors to verify the pitch with a third party instead of trusting
// ad copy. Implemented as copy-the-prompt + open-the-tool rather than
// a "?q=" deep link: none of ChatGPT/Perplexity/Claude's query-prefill
// URL params are documented, stable, first-party behavior, and
// Claude's (claude.ai/new?q=) was confirmed removed in Oct 2025 after
// a prompt-injection disclosure — a broken or flagged deep link would
// undercut the trust this section exists to build.
const CAYE_AI_PROMPT =
  "I'm evaluating Caye, a WhatsApp AI hire for Caribbean tour and hospitality businesses (meetcaye.com). What does it do, what are its strengths and weaknesses, and who is it for?"

const AI_ASK_TARGETS = [
  { label: 'ChatGPT', href: 'https://chatgpt.com/' },
  { label: 'Perplexity', href: 'https://www.perplexity.ai/' },
  { label: 'Claude', href: 'https://claude.ai/new' },
]

// Hero load choreography — one staggered settle on page load (eyebrow →
// headline → subhead → CTA), then the page goes quiet. Scroll reveals
// below the fold use whileInView with the same easing family.
const heroEase = [0.25, 0.1, 0.25, 1] as const
const heroItem = (delay: number) => ({
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.8, ease: heroEase, delay },
})

// Testimonial slot — OFF until a pilot converts to paid. When Karenda
// (or whoever pays first) gives a real quote, drop it in and flip the
// flag. Shape mirrors Viktor's case-study card (gradient stat panel +
// white detail panel with two stat pills) — fill every field with real
// numbers/quotes from the first paying customer, never placeholders.
const SHOW_TESTIMONIAL = false
const TESTIMONIAL = {
  statHeadline: '', // e.g. "40 fewer calls a week. One Caye."
  avatarSrc: '', // e.g. /clients/karenda.jpg
  name: '', // e.g. Karenda R.
  role: '', // e.g. Owner, Bimini Island Tours
  eyebrow: '', // e.g. Tour operator · Bimini
  headline: '', // e.g. "From missed messages to a run front desk"
  description: '', // 1-2 sentences, specific over adjective-heavy
  stats: [
    { value: '', label: '', Icon: ClockCountdownIcon }, // e.g. "< 2 min", "Avg. reply time"
    { value: '', label: '', Icon: CalendarCheckIcon }, // e.g. "18", "Bookings via Caye"
  ],
}

export default function LandingPageClient() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [copiedAiTarget, setCopiedAiTarget] = useState<string | null>(null)

  // Copies the suggested prompt then opens the tool in a new tab — see
  // the AI_ASK_TARGETS comment for why this isn't a "?q=" deep link.
  async function handleAskAi(label: string, href: string) {
    try {
      await navigator.clipboard.writeText(CAYE_AI_PROMPT)
      setCopiedAiTarget(label)
      setTimeout(() => setCopiedAiTarget((v) => (v === label ? null : v)), 2000)
    } catch {
      // Clipboard API unavailable (permissions, insecure context) —
      // still open the tool so the click isn't a dead end.
    }
    sendGAEvent('event', 'ask_ai_click', { location: label })
    window.open(href, '_blank', 'noopener,noreferrer')
  }

  // Dashboard CSS sets body { overflow: hidden }. The .lp-body class in
  // globals.css overrides it to overflow: auto so the landing can scroll.
  useEffect(() => {
    document.body.classList.add('lp-body')
    return () => {
      document.body.classList.remove('lp-body')
    }
  }, [])

  // Floating nav — nudges to a slightly more opaque/closer shadow once
  // the page scrolls past the hero, so it stays legible over whatever
  // section is underneath it.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="min-h-screen bg-cream text-near-black font-sans selection:bg-caribbean-teal selection:text-white">
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden flex flex-col bg-white">
        {/* Soft ambient glow behind the whole hero — echoes the mockup's
            near-white background with a faint blue/gold wash rather than
            the full moving mesh gradient the previous hero used. */}
        <div aria-hidden className="absolute inset-0 pointer-events-none">
          <div
            className="absolute inset-x-0 top-0 h-[900px]"
            style={{
              background:
                'radial-gradient(60% 50% at 50% 0%, rgba(78,190,206,0.10), transparent 70%), radial-gradient(40% 35% at 82% 8%, rgba(255,228,175,0.35), transparent 70%)',
            }}
          />
        </div>

        {/* Top bar — floating glass pill, same visual language as the
            "Live, right now, in WhatsApp" chip below (rounded-full,
            white/60, backdrop-blur, soft shadow). Scoped to what this
            single-scroll page actually has: two real section anchors and
            one action, not a Viktor-style mega-nav with Solution/
            Resources/Customers dropdowns — that implies a multi-page
            site Caye doesn't have. Still no "Log in": nobody logs into
            the app itself, they talk to Caye in WhatsApp; login stays in
            the footer for the rare operator who needs the dashboard. */}
        <header
          className={`fixed inset-x-4 top-4 z-50 mx-auto flex max-w-2xl items-center justify-between gap-3 rounded-full border border-near-black/10 bg-white/70 px-4 py-2.5 backdrop-blur-md transition-shadow duration-300 md:inset-x-8 md:top-6 md:max-w-3xl md:px-5 md:py-3 ${
            scrolled
              ? 'shadow-[0_10px_32px_-10px_rgba(14,26,26,0.24)] bg-white/85'
              : 'shadow-[0_6px_20px_-10px_rgba(14,26,26,0.15)]'
          }`}
        >
          <Link href="/" className="flex items-center select-none pl-1.5">
            <span className="font-logo font-semibold tracking-tight text-[#0E1A1A]" style={{ fontSize: 19 }}>
              caye
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            <a
              href="#channels"
              className="px-4 py-2 rounded-full text-[13.5px] font-medium text-near-black/65 hover:text-near-black hover:bg-near-black/5 transition-colors"
            >
              How she works
            </a>
            <a
              href="#faq"
              className="px-4 py-2 rounded-full text-[13.5px] font-medium text-near-black/65 hover:text-near-black hover:bg-near-black/5 transition-colors"
            >
              FAQ
            </a>
          </nav>

          <div className="flex items-center gap-1.5">
            <a
              href={CAYE_SIGNUP_WA_HREF}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackSignupClick('nav')}
              className="hidden sm:inline-flex items-center gap-1.5 text-white font-logo font-semibold px-5 py-2 rounded-full text-[14px] transition-all shadow-[0_4px_14px_-6px_rgba(7,102,163,0.45)] hover:-translate-y-px active:translate-y-0"
              style={{ backgroundImage: 'linear-gradient(100deg, #0766A3 0%, #4EBECE 55%, #FFE4AF 100%)' }}
            >
              Start Free Trial
            </a>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileMenuOpen}
              className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-full text-near-black/80 hover:bg-near-black/5 transition-colors cursor-pointer"
            >
              {mobileMenuOpen ? <XIcon size={19} weight="bold" /> : <ListIcon size={19} weight="bold" />}
            </button>
          </div>
        </header>

        {/* Mobile menu sheet — anchors + CTA, dismisses on tap */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: heroEase }}
              className="fixed inset-x-4 top-[68px] z-40 rounded-3xl border border-near-black/10 bg-white/95 backdrop-blur-md shadow-[0_16px_40px_-12px_rgba(14,26,26,0.25)] p-2 md:hidden"
            >
              <a
                href="#channels"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-4 py-3 rounded-2xl text-[15px] font-medium text-near-black/80 hover:bg-near-black/5"
              >
                How she works
              </a>
              <a
                href="#faq"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-4 py-3 rounded-2xl text-[15px] font-medium text-near-black/80 hover:bg-near-black/5"
              >
                FAQ
              </a>
              <a
                href={CAYE_SIGNUP_WA_HREF}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  trackSignupClick('mobile_menu')
                  setMobileMenuOpen(false)
                }}
                className="block mt-1 px-4 py-3 rounded-2xl text-[16px] font-logo font-semibold text-white text-center"
                style={{ backgroundImage: 'linear-gradient(100deg, #0766A3 0%, #4EBECE 55%, #FFE4AF 100%)' }}
              >
                Start Free Trial
              </a>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Hero content — top padding compensates for the nav now being
            `fixed` (out of flow) instead of sitting in-line above this,
            so it clears the floating pill instead of sliding under it. */}
        <div className="relative z-10 flex-1 flex flex-col items-center px-6 pt-28 md:pt-32">
          <div className="max-w-3xl mx-auto text-center">
            {/* Headline — two-tier mockup copy: "Hire Caye." in near-black,
                "Your AI employee." in the brand blue as the direct
                accent line, same Fraunces (font-logo) face used for the
                "caye" wordmark in the nav. */}
            <motion.h1
              {...heroItem(0.18)}
              className="font-logo text-[2.75rem] sm:text-6xl md:text-[5rem] lg:text-[5.75rem] font-extrabold tracking-[-0.03em] text-near-black leading-[1.05]"
            >
              Hire Caye.
              <br />
              <span style={{ color: '#0766A3' }}>Your AI employee.</span>
            </motion.h1>

            <motion.p
              {...heroItem(0.34)}
              className="mt-8 font-newsreader text-[1.2rem] md:text-[1.35rem] leading-[1.45] text-near-black/85 max-w-2xl mx-auto font-light"
              style={{ fontStyle: 'normal' }}
            >
              One employee. One conversation.
              <br />
              Run your business. Grow your business.
            </motion.p>

            {/* Primary CTA */}
            <motion.div
              {...heroItem(0.5)}
              className="mt-10 flex flex-col items-center gap-3"
            >
              <a
                href={CAYE_SIGNUP_WA_HREF}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackSignupClick('hero')}
                className="group relative inline-flex items-center gap-2.5 text-white font-logo font-semibold px-9 py-4 rounded-full text-[16px] transition-all shadow-[0_10px_30px_-8px_rgba(7,102,163,0.45)] hover:shadow-[0_14px_38px_-8px_rgba(7,102,163,0.55)] hover:-translate-y-[1px] active:translate-y-0"
                style={{ backgroundImage: 'linear-gradient(100deg, #0766A3 0%, #4EBECE 55%, #FFE4AF 100%)' }}
              >
                <span>Start Your 7-Day Free Trial</span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  className="transition-transform group-hover:translate-x-1"
                >
                  <path
                    d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </a>
              <p className="mt-1 flex items-center gap-1.5 text-[13.5px] text-near-black/60">
                <CheckIcon size={14} weight="bold" className="text-caribbean-teal-hover" />
                No credit card required. Cancel anytime.
              </p>
            </motion.div>
          </div>

          {/* Orb + six-card ring — the mockup's central feature graphic.
              Central glowing sphere on a translucent stage ring, flanked
              by three cards on each side naming what Caye does. Stacks
              to a single column of cards under the orb on mobile. */}
          <div className="relative mt-16 md:mt-20 w-full max-w-5xl mx-auto">
            <div className="grid md:grid-cols-[1fr_auto_1fr] items-center gap-6 md:gap-4">
              <div className="grid gap-4 order-2 md:order-1">
                {HERO_FEATURE_CARDS.filter((_, i) => i % 2 === 0).map((card, i) => (
                  <motion.div
                    key={card.title}
                    initial={{ opacity: 0, x: -16 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true, margin: '-60px' }}
                    transition={{ duration: 0.55, ease: heroEase, delay: 0.1 + i * 0.08 }}
                    className="flex items-start gap-3 rounded-2xl border border-near-black/[0.08] bg-white px-5 py-4 shadow-[0_16px_40px_-24px_rgba(14,26,26,0.35)] md:max-w-[260px] md:ml-auto"
                  >
                    <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-[#0766A3]/10 flex-shrink-0">
                      <card.Icon size={18} weight="bold" color="#0766A3" />
                    </span>
                    <div>
                      <p className="font-newsreader text-[1.02rem] text-near-black">{card.title}</p>
                      <p className="mt-0.5 text-[13px] leading-snug text-near-black/55">{card.desc}</p>
                    </div>
                  </motion.div>
                ))}
              </div>

              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.7, ease: heroEase }}
                className="relative order-1 md:order-2 flex flex-col items-center justify-self-center"
              >
                <div
                  className="relative w-48 h-48 md:w-64 md:h-64 rounded-full"
                  style={{
                    backgroundImage:
                      'radial-gradient(38% 38% at 32% 28%, rgba(255,255,255,0.9), transparent 60%), conic-gradient(from 200deg, #0766A3, #4EBECE, #FFE4AF, #0766A3)',
                    boxShadow: '0 30px 80px -20px rgba(7,102,163,0.45), 0 0 0 14px rgba(7,102,163,0.05)',
                  }}
                >
                  <span aria-hidden className="absolute inset-0 rounded-full" style={{ boxShadow: 'inset 0 8px 24px rgba(255,255,255,0.35), inset 0 -12px 30px rgba(7,102,163,0.35)' }} />
                </div>
                {/* Stage ring */}
                <div
                  aria-hidden
                  className="mt-3 w-56 md:w-72 h-4 rounded-[100%] border border-[#4EBECE]/30"
                  style={{ background: 'radial-gradient(closest-side, rgba(78,190,206,0.18), transparent 75%)' }}
                />
              </motion.div>

              <div className="grid gap-4 order-3">
                {HERO_FEATURE_CARDS.filter((_, i) => i % 2 === 1).map((card, i) => (
                  <motion.div
                    key={card.title}
                    initial={{ opacity: 0, x: 16 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true, margin: '-60px' }}
                    transition={{ duration: 0.55, ease: heroEase, delay: 0.1 + i * 0.08 }}
                    className="flex items-start gap-3 rounded-2xl border border-near-black/[0.08] bg-white px-5 py-4 shadow-[0_16px_40px_-24px_rgba(14,26,26,0.35)] md:max-w-[260px]"
                  >
                    <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-[#0766A3]/10 flex-shrink-0">
                      <card.Icon size={18} weight="bold" color="#0766A3" />
                    </span>
                    <div>
                      <p className="font-newsreader text-[1.02rem] text-near-black">{card.title}</p>
                      <p className="mt-0.5 text-[13px] leading-snug text-near-black/55">{card.desc}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Everything. Everywhere. Handled. — mockup's follow-up panel:
          a bordered card with headline + subtext and a four-stat row
          (saves time / increases revenue / reduces costs / works
          24-7), then a "Trusted by" line with four badge chips. Takes
          the place of the old single-sentence reinforcing statement,
          which covered the same "why Caye" beat. ── */}
      <section className="relative py-20 md:py-28 px-6 bg-cream">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.7, ease: heroEase }}
          className="max-w-4xl mx-auto rounded-[2rem] border border-near-black/[0.08] bg-white px-6 py-12 md:px-14 md:py-16 text-center shadow-[0_30px_80px_-40px_rgba(14,26,26,0.25)]"
        >
          <h2 className="font-logo text-[2rem] sm:text-4xl md:text-[2.75rem] font-extrabold tracking-[-0.02em] leading-[1.15] text-near-black">
            Everything. Everywhere. Handled.
          </h2>
          <p className="mt-4 font-newsreader text-[15.5px] md:text-[16.5px] leading-[1.6] text-near-black/60 max-w-xl mx-auto">
            Caye works in the background 24/7 so you can focus on what actually moves your business forward.
          </p>

          <div className="mt-10 grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-6">
            {HERO_STAT_ITEMS.map(({ title, desc, Icon, badge }) => (
              <div key={title} className="flex flex-col items-center text-center">
                <span className="flex items-center justify-center w-14 h-14 rounded-full bg-[#0766A3]/10">
                  {Icon ? (
                    <Icon size={22} weight="bold" color="#0766A3" />
                  ) : (
                    <span className="font-logo text-[13px] font-extrabold" style={{ color: '#0766A3' }}>{badge}</span>
                  )}
                </span>
                <p className="mt-3 font-newsreader text-[1rem] text-near-black">{title}</p>
                <p className="mt-1 text-[13px] leading-snug text-near-black/55 max-w-[150px]">{desc}</p>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.6, ease: heroEase, delay: 0.1 }}
          className="mt-14 text-center"
        >
          <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-near-black/45 font-medium">
            Trusted by forward-thinking businesses
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
            {TRUST_BADGES.map(({ label, Icon }) => (
              <span key={label} className="inline-flex items-center gap-2 text-[13.5px] font-medium text-near-black/60">
                <Icon size={16} weight="bold" className="text-near-black/45" />
                {label}
              </span>
            ))}
          </div>
        </motion.div>
      </section>

      {/* ── Channel strip — front desk vs. back office ─────────────
          Bento of two card weights: one live gradient card (the
          gradient reuses the exact hero-mesh / testimonial-panel
          stops, teal → gold, so it reads as this brand's own visual
          system rather than a borrowed Viktor-violet card) plus two
          quiet outline cards. Instagram/Messenger webhooks are built
          but not yet proven end-to-end (per PRODUCT.md), so they stay
          named honestly as "next" rather than given equal billing with
          WhatsApp — impeccable critique 2026-07-29 flagged the prior
          three-way row as an overclaim; that constraint carries over
          into card weight, not just copy. Zoho Mail / calendar are
          back-office reads/writes, not conversation surfaces, so they
          get the same quiet treatment. ── */}
      <section id="channels" className="relative py-24 md:py-28 px-6 bg-cream border-y border-near-black/[0.06] scroll-mt-24">
        <div className="max-w-5xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, ease: heroEase }}
            className="flex items-center justify-center gap-3 mb-12"
          >
            <span className="h-px w-8 bg-near-black/30" />
            <h2 className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/60 font-medium">
              Where she works
            </h2>
            <span className="h-px w-8 bg-near-black/30" />
          </motion.div>

          <div className="grid gap-5 md:grid-cols-5">
            {/* Primary — WhatsApp, the live front desk */}
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.65, ease: heroEase, delay: 0.05 }}
              className="md:col-span-3 relative rounded-[2rem] overflow-hidden border border-near-black/[0.06] bg-white shadow-[0_30px_70px_-28px_rgba(14,26,26,0.26)]"
            >
              <div
                className="relative flex flex-col items-center justify-center h-52 md:h-64 overflow-hidden"
                style={{
                  backgroundImage:
                    'linear-gradient(160deg, #0766A3 0%, #2E7A8C 34%, #4EBECE 64%, #FFE4AF 100%)',
                }}
              >
                <span aria-hidden className="absolute -top-14 -left-10 w-56 h-56 rounded-full bg-white/10 blur-3xl" />
                <span aria-hidden className="absolute -bottom-16 -right-12 w-64 h-64 rounded-full bg-[#FFE4AF]/25 blur-3xl" />

                <span className="absolute top-5 left-5 inline-flex items-center gap-1.5 rounded-full bg-white/15 border border-white/25 backdrop-blur-sm px-3 py-1.5">
                  <span className="relative flex h-[6px] w-[6px]">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-70" />
                    <span className="relative inline-flex h-[6px] w-[6px] rounded-full bg-white" />
                  </span>
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-white font-medium">
                    Live now
                  </span>
                </span>

                <span className="relative flex items-center justify-center w-16 h-16 rounded-full bg-white/95 shadow-[0_10px_30px_-8px_rgba(7,102,163,0.5)]">
                  <WhatsappLogoIcon size={30} weight="fill" color="#0FB5A1" />
                </span>
              </div>

              <div className="p-6 md:p-8">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-near-black/45 font-medium">
                  Front desk
                </p>
                <h3 className="mt-2 font-instrument text-[1.6rem] md:text-[1.85rem] tracking-[-0.01em] text-near-black">
                  WhatsApp
                </h3>
                <p className="mt-2.5 font-newsreader text-[15px] leading-[1.6] text-near-black/65 max-w-md">
                  Guests message the number you already have. Caye answers from inside that conversation — no app to install, no new number to learn.
                </p>
              </div>
            </motion.div>

            {/* Secondary — quiet outline cards, no gradient fill, so
                they don't compete visually with the live card above */}
            <div className="md:col-span-2 grid gap-5">
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.6, ease: heroEase, delay: 0.16 }}
                className="rounded-[1.5rem] border border-near-black/[0.08] bg-white/60 backdrop-blur-sm p-6"
              >
                <div className="flex items-center gap-2">
                  <span className="flex items-center justify-center w-9 h-9 rounded-full bg-near-black/[0.05] flex-shrink-0">
                    <InstagramLogoIcon size={16} weight="bold" color="#0E1A1A" />
                  </span>
                  <span className="flex items-center justify-center w-9 h-9 rounded-full bg-near-black/[0.05] flex-shrink-0 -ml-3">
                    <MessengerLogoIcon size={16} weight="bold" color="#0E1A1A" />
                  </span>
                  <span className="ml-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-near-black/45 font-medium">
                    Rolling out next
                  </span>
                </div>
                <h3 className="mt-3.5 font-newsreader text-[1.05rem] text-near-black/85">
                  Instagram &amp; Messenger
                </h3>
                <p className="mt-1.5 font-newsreader text-[13.5px] leading-[1.55] text-near-black/55">
                  Same Caye, same front desk — coming to your other inboxes next.
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.6, ease: heroEase, delay: 0.24 }}
                className="rounded-[1.5rem] border border-near-black/[0.08] bg-white/60 backdrop-blur-sm p-6"
              >
                <div className="flex items-center gap-2">
                  <span className="flex items-center justify-center w-9 h-9 rounded-full bg-near-black/[0.05] flex-shrink-0">
                    <EnvelopeSimpleIcon size={16} weight="bold" color="#0E1A1A" />
                  </span>
                  <span className="flex items-center justify-center w-9 h-9 rounded-full bg-near-black/[0.05] flex-shrink-0 -ml-3">
                    <CalendarBlankIcon size={16} weight="bold" color="#0E1A1A" />
                  </span>
                  <span className="ml-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-near-black/45 font-medium">
                    Back office
                  </span>
                </div>
                <h3 className="mt-3.5 font-newsreader text-[1.05rem] text-near-black/85">
                  Zoho Mail &amp; your calendar
                </h3>
                <p className="mt-1.5 font-newsreader text-[13.5px] leading-[1.55] text-near-black/55">
                  She quietly reads and writes here too — no conversation, just the work getting done.
                </p>
              </motion.div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Ask AI — see AI_ASK_TARGETS comment above for why this is
          copy-prompt + open-tool rather than a deep link. Same gradient
          system as the channel-strip WhatsApp card and testimonial
          panel (teal → gold), not Viktor's violet. ── */}
      <section className="relative py-20 md:py-24 px-6 bg-cream">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.7, ease: heroEase }}
            className="relative overflow-hidden rounded-[2.25rem] px-7 py-10 md:px-12 md:py-14"
            style={{
              backgroundImage:
                'linear-gradient(155deg, #0766A3 0%, #2E7A8C 30%, #4EBECE 58%, #7BB2BF 78%, #FFE4AF 100%)',
            }}
          >
            <span aria-hidden className="absolute -top-20 -right-16 w-72 h-72 rounded-full bg-white/10 blur-3xl" />
            <span aria-hidden className="absolute -bottom-24 -left-20 w-80 h-80 rounded-full bg-[#FFE4AF]/20 blur-3xl" />

            <div className="relative grid md:grid-cols-[1.1fr_1fr] gap-9 md:gap-10 items-center">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/70 font-medium">
                  No script, no spin
                </p>
                <h2 className="mt-3 font-logo text-[2.1rem] md:text-[2.6rem] font-extrabold tracking-[-0.02em] leading-[1.08] text-white">
                  Ask AI about Caye.
                </h2>
                <p className="mt-4 font-newsreader text-[15.5px] leading-[1.6] text-white/85 max-w-sm">
                  Don&rsquo;t take our word for it. Copy the prompt and ask ChatGPT, Perplexity, or Claude what they think.
                </p>

                <div className="mt-6 flex flex-wrap gap-2.5">
                  {AI_ASK_TARGETS.map(({ label, href }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => handleAskAi(label, href)}
                      className="inline-flex items-center gap-2 rounded-full bg-white/95 hover:bg-white text-near-black font-medium text-[13.5px] px-4 py-2.5 transition-all hover:-translate-y-px shadow-[0_6px_20px_-8px_rgba(7,26,26,0.35)]"
                    >
                      <ArrowSquareOutIcon size={13} weight="bold" color="#0D9C8B" />
                      {copiedAiTarget === label ? 'Copied — opening…' : label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative rounded-2xl bg-white/12 border border-white/25 backdrop-blur-sm px-6 py-6">
                <span aria-hidden className="font-logo text-[2.5rem] leading-none text-white/30">&ldquo;</span>
                <p className="-mt-3 font-newsreader italic text-[14.5px] md:text-[15px] leading-[1.55] text-white">
                  {CAYE_AI_PROMPT}
                </p>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── FAQ — simplified into a Viktor-style two-column accordion
          (title left, rows right, first one open). Still fully static:
          native <details>/<summary> keeps every answer's full text in
          the server-rendered HTML even while collapsed, so crawlers
          and AI answer engines see the same content a click would
          reveal — the constraint from the old plain-list version
          carries over, just with a simpler look. Copy is mirrored into
          FAQPage JSON-LD in app/page.tsx; keep FAQ_ITEMS as the single
          source of truth. ── */}
      <section id="faq" className="relative py-20 md:py-28 px-6 bg-cream scroll-mt-24">
        <div className="max-w-5xl mx-auto grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)] gap-8 md:gap-16">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, ease: heroEase }}
            className="md:sticky md:top-32 md:self-start"
          >
            <h2 className="font-logo text-[2.5rem] md:text-[3rem] font-extrabold tracking-[-0.02em] text-near-black leading-none">
              Questions
            </h2>
            <span className="mt-4 block h-[3px] w-14 bg-caribbean-teal rounded-full" />
          </motion.div>

          <div className="space-y-3">
            {FAQ_ITEMS.map((item, i) => (
              <motion.details
                key={item.q}
                open={i === 0}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.5, ease: heroEase, delay: i * 0.05 }}
                className="group rounded-2xl border border-near-black/[0.08] bg-white px-6 py-5 md:px-7 md:py-5.5 [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex items-center justify-between gap-4 cursor-pointer list-none">
                  <span className="font-newsreader text-[1.05rem] md:text-[1.12rem] text-near-black group-open:text-caribbean-teal-hover transition-colors">
                    {item.q}
                  </span>
                  <CaretDownIcon
                    size={15}
                    weight="bold"
                    className="flex-shrink-0 text-near-black/35 transition-transform duration-300 group-open:rotate-180 group-open:text-caribbean-teal-hover"
                  />
                </summary>
                <p className="mt-3 font-newsreader text-[15px] leading-[1.6] text-near-black/65 pr-6">
                  {item.a}
                </p>
              </motion.details>
            ))}
          </div>
        </div>
      </section>

      {/* ── Proof — first paid-customer story goes here ──────────────
          Slot is built and styled; flip `SHOW_TESTIMONIAL` to true and
          fill in every TESTIMONIAL field with real numbers/quotes once
          a pilot converts to paid. No fabricated praise before then.

          Layout borrowed directly from Viktor's case-study card: a
          split panel, saturated gradient stat-block on one side (photo
          + one bold sentence of proof) and a plain white detail panel
          on the other (eyebrow, headline, description, two stat
          pills). Gradient reuses the same stops as the footer wordmark
          and hero mesh — teal → gold, Caye's own palette, not
          Viktor's violet — so it reads as this brand's bookend rather
          than a borrowed look. */}
      {SHOW_TESTIMONIAL && (
        <section className="relative py-20 md:py-28 px-6 bg-cream">
          <div className="max-w-5xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 28 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.7, ease: heroEase }}
              className="grid md:grid-cols-2 rounded-[2.5rem] overflow-hidden border border-near-black/[0.06] bg-white shadow-[0_40px_90px_-30px_rgba(14,26,26,0.32)]"
            >
              {/* Left — gradient stat panel */}
              <div
                className="relative flex flex-col justify-between p-8 md:p-10 min-h-[320px] md:min-h-[460px] overflow-hidden"
                style={{
                  backgroundImage:
                    'linear-gradient(160deg, #0766A3 0%, #2E7A8C 34%, #4EBECE 64%, #FFE4AF 100%)',
                }}
              >
                <span
                  aria-hidden
                  className="absolute -top-16 -right-10 w-64 h-64 rounded-full bg-white/10 blur-3xl"
                />
                <span
                  aria-hidden
                  className="absolute -bottom-20 -left-16 w-72 h-72 rounded-full bg-[#FFE4AF]/25 blur-3xl"
                />

                <p className="relative font-logo text-[1.9rem] md:text-[2.3rem] font-extrabold leading-[1.12] tracking-[-0.02em] text-white">
                  {TESTIMONIAL.statHeadline}
                </p>

                <div className="relative mt-8 flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-white/20 border border-white/40 overflow-hidden flex-shrink-0">
                    {TESTIMONIAL.avatarSrc && (
                      <img
                        src={TESTIMONIAL.avatarSrc}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div>
                    <p className="font-newsreader text-[15px] text-white">{TESTIMONIAL.name}</p>
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/75">
                      {TESTIMONIAL.role}
                    </p>
                  </div>
                </div>
              </div>

              {/* Right — white detail panel */}
              <div className="flex flex-col justify-center p-8 md:p-12">
                <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-near-black/50 font-medium">
                  {TESTIMONIAL.eyebrow}
                </p>
                <h3 className="mt-3 font-logo text-[1.7rem] md:text-[2.1rem] font-extrabold tracking-[-0.02em] leading-[1.12] text-near-black">
                  {TESTIMONIAL.headline}
                </h3>
                <p className="mt-4 font-newsreader text-[15.5px] leading-[1.65] text-near-black/70">
                  {TESTIMONIAL.description}
                </p>

                <div className="mt-8 grid grid-cols-2 gap-3">
                  {TESTIMONIAL.stats.map(({ value, label, Icon }) => (
                    <div
                      key={label}
                      className="rounded-2xl border border-near-black/[0.07] bg-[#FFF6E9] px-4 py-4"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-logo text-[1.6rem] font-extrabold text-near-black">
                          {value}
                        </span>
                        <span className="flex items-center justify-center w-8 h-8 rounded-full bg-caribbean-teal/[0.12] flex-shrink-0">
                          <Icon size={15} weight="bold" color="#0D9C8B" />
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-near-black/55">
                        {label}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        </section>
      )}

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-near-black/[0.08] bg-cream overflow-hidden">
        <div className="max-w-7xl mx-auto px-6 md:px-12 pt-16 md:pt-20 pb-10">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-x-8 gap-y-12">
            {/* Brand column */}
            <div className="col-span-2 pr-4">
              <div className="flex items-center gap-2.5">
                <img src="/caye-logo-icon.png" alt="" aria-hidden className="w-5 h-5 rounded-full object-cover" />
                <span className="font-logo font-semibold tracking-tight text-near-black text-[22px]">
                  caye
                </span>
              </div>
              <p className="mt-4 font-newsreader text-[15px] leading-relaxed text-near-black/60 max-w-[240px]">
                Not a tool. A hire. You text her like staff — no
                dashboard, ever.
              </p>
              <div className="mt-5 flex items-center gap-2">
                <span className="relative flex h-[7px] w-[7px]">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-caribbean-teal opacity-60" />
                  <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-caribbean-teal" />
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-near-black/45 font-medium">
                  She&rsquo;s online
                </span>
              </div>
            </div>

            {FOOTER_COLUMNS.map((col) => (
              <div key={col.title}>
                <div className="flex items-center gap-2 mb-4">
                  <span className="h-px w-4 bg-caribbean-teal/50" />
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-near-black/45 font-medium">
                    {col.title}
                  </span>
                </div>
                <ul className="space-y-3">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      {link.href.startsWith('/') ? (
                        <Link
                          href={link.href}
                          className="text-[14px] text-near-black/65 underline decoration-caribbean-teal/30 decoration-[1.5px] underline-offset-4 hover:text-near-black hover:decoration-near-black/40 transition-colors"
                        >
                          {link.label}
                        </Link>
                      ) : (
                        <a
                          href={link.href}
                          {...(link.external
                            ? { target: '_blank', rel: 'noopener noreferrer' }
                            : {})}
                          onClick={link.href === CAYE_SIGNUP_WA_HREF ? () => trackSignupClick('footer') : undefined}
                          className="text-[14px] text-near-black/65 underline decoration-caribbean-teal/30 decoration-[1.5px] underline-offset-4 hover:text-near-black hover:decoration-near-black/40 transition-colors"
                        >
                          {link.label}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-10 pt-5 border-t border-near-black/[0.07]">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-near-black/45 font-medium">
              © 2026 Caye by TropiTech · Built in Eleuthera, Bahamas
            </span>
          </div>
        </div>

        {/* Sign-painted wordmark — the family-island welcome-sign move
            (ELEUTHERA-style hand-lettered block signage: a vivid paint
            gradient) reinterpreted in the hero's own sunset-over-sea
            palette. Full-bleed (outside the 7xl container) so it has the
            whole viewport to scale into. Renders at natural height (no
            fixed-em crop) so descenders never get sliced regardless of
            which --font-logo typeface is active; mb below adds the
            breathing room a tight crop used to fake. */}
        <div
          aria-hidden
          className="select-none pointer-events-none flex items-start justify-center gap-3 md:gap-5 px-4 -mt-10 md:-mt-16"
          style={{
            fontSize: 'clamp(6rem, 30vw, 26rem)',
            background:
              'linear-gradient(180deg, transparent 0%, rgba(123,178,191,0.14) 100%)',
          }}
        >
          <span className="self-center h-px w-6 md:w-12 bg-near-black/15 flex-shrink-0" />
          <span
            className="text-center font-logo font-bold whitespace-nowrap"
            style={{
              fontSize: '1em',
              lineHeight: 1,
              paddingBottom: '0.18em',
              backgroundImage:
                'linear-gradient(180deg, #FFE4AF 0%, #F4E3A0 24%, #7BB2BF 52%, #4EBECE 76%, #0766A3 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            caye
          </span>
          <span className="self-center h-px w-6 md:w-12 bg-near-black/15 flex-shrink-0" />
        </div>
      </footer>
    </div>
  )
}
