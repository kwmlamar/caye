'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { MeshGradient } from '@paper-design/shaders-react'
import { WhatsappLogoIcon, ListIcon, XIcon } from '@phosphor-icons/react'
import WhatsAppMockup from '@/components/landing/WhatsAppMockup'
import { FAQ_ITEMS } from '@/components/landing/faq-data'

// Simplified landing — credibility surface, not a conversion engine.
// Primary CTA goes straight to a demo request (lamar@tropitech.org).
// Self-serve signup is quiet in the footer until embedded-signup ships.
//
// Typography:
//   Headline   — Instrument Serif (editorial display, italic accent)
//   Subhead    — Newsreader light (editorial deck/subtitle, pairs with Instrument)
//   Eyebrow    — JetBrains Mono uppercase (editorial dateline)
//   Body / nav — Geist (sans, product-UI default)

// Hero mesh-gradient palettes. To A/B test: swap which palette is
// assigned to HERO_COLORS below and reload.
//
// Soft Caribbean (original) — all muted, spa-coded:
const PALETTE_SOFT = ['#72b9bb', '#b5d9d9', '#ffd1bd', '#ffebe0', '#8cc5b8', '#dbf4a4']
// Caribbean Deep — Bahamian flag DNA (aqua direct, gold echoed),
// deeper sea-pool, sand + cream + mint harmonize. RECOMMENDED.
const PALETTE_DEEP = ['#0766A3', '#4EBECE', '#FFE4AF', '#F5E8D0', '#7BB2BF', '#F4E3A0']
// Sunset / golden hour — warmer, more sand/coral, less green:
const PALETTE_SUNSET = ['#3A8B98', '#A8D5D5', '#FFC4A0', '#FFE5D0', '#FFE4AF', '#FFB5A8']
// Reef + water — vivid snorkel palette, deepest contrast:
const PALETTE_REEF = ['#2E7A8C', '#6DC4C9', '#FFD580', '#F5E8D0', '#7BB2BF', '#FF9B85']

const HERO_COLORS = PALETTE_DEEP

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

// Front desk — the channel Caye actually talks to customers through
// end-to-end, proven and live. Instagram/Messenger webhooks are built
// but not yet proven end-to-end (per PRODUCT.md), so they're named as
// "rolling out next" below rather than given equal billing here —
// impeccable critique 2026-07-29 flagged the prior three-way row as an
// overclaim. Zoho Mail / calendar are back-office reads/writes, not
// conversation surfaces, so they get quiet secondary treatment too.
const FRONT_DESK_CHANNELS = [
  { label: 'WhatsApp', Icon: WhatsappLogoIcon, bg: '#DFF5E4', color: '#1F9D55' },
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

// Suppress unused-vars warnings — these are intentional toggles.
void PALETTE_SOFT
void PALETTE_SUNSET
void PALETTE_REEF

// Testimonial slot — OFF until a pilot converts to paid. When Karenda
// (or whoever pays first) gives a real quote, drop it in and flip the
// flag. The section is fully styled and reveals on scroll.
const SHOW_TESTIMONIAL = false
const TESTIMONIAL = {
  quote: '', // e.g. “Caye booked three tours while I was out on the water.”
  name: '', // e.g. Karenda R.
  business: '', // e.g. Tour operator, Bimini
}

export default function LandingPageClient() {
  const [dimensions, setDimensions] = useState({ width: 1920, height: 1080 })
  const [mounted, setMounted] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Phone dock's top offset — floor keeps it clear of the CTA block (now
  // including the WhatsApp badge, which lives in normal document flow
  // right below the CTA text rather than at a guessed absolute pixel
  // offset) on short viewports; the 0.6 factor pulls it toward the fold
  // on taller viewports so it doesn't sit awkwardly high with empty
  // space beneath it.
  const phoneTopOffset = Math.max(620, dimensions.height * 0.6)

  // Phone grows a bit on wider screens — purely a size choice now, not
  // constrained by a crop budget (see heroMinHeight below).
  const phoneScale =
    dimensions.width >= 1024
      ? 1.05
      : dimensions.width >= 768
        ? 0.95
        : dimensions.width >= 640
          ? 0.85
          : 0.75

  // Full rendered height of the phone frame (bezel + screen) at this scale.
  const estimatedPhoneHeight = 700 * phoneScale

  // The hero used to be exactly one viewport tall and rely on
  // overflow-hidden to crop the phone for a stylized "below the fold"
  // look — but that meant the crop line could land mid-message or hide
  // the phone's bottom half entirely depending on viewport height. Instead
  // size the section to always fully contain the phone (never shorter
  // than one viewport, so the hero still reads as a hero on tall screens).
  const heroMinHeight = Math.max(
    dimensions.height,
    phoneTopOffset + estimatedPhoneHeight + 140
  )

  useEffect(() => {
    setMounted(true)
    const update = () =>
      setDimensions({ width: window.innerWidth, height: window.innerHeight })
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

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
  // section is underneath it (mesh gradient vs. flat cream).
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="min-h-screen bg-cream text-near-black font-sans selection:bg-caribbean-teal selection:text-white">
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section
        className="relative overflow-hidden flex flex-col"
        style={{ minHeight: heroMinHeight }}
      >
        {/* Mesh gradient background */}
        <div className="absolute inset-0 w-full h-full">
          {mounted && (
            <>
              <MeshGradient
                width={dimensions.width}
                height={heroMinHeight}
                colors={HERO_COLORS}
                distortion={0.8}
                swirl={0.6}
                grainMixer={0}
                grainOverlay={0}
                speed={0.42}
                offsetX={0.08}
              />
              <div className="absolute inset-0 pointer-events-none bg-cream/10" />
              {/* Contrast scrim — a soft radial lightening behind the
                  text column specifically (not the whole mesh), so the
                  headline/subhead/caption sit on a calmer, more uniform
                  patch instead of directly on whatever hue the moving
                  mesh happens to be at that moment. Fixes legibility
                  without touching font size or weight. Mesh stays fully
                  vivid at the edges (behind the phone mock, corners). */}
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-[620px] pointer-events-none"
                style={{
                  background:
                    'radial-gradient(720px 460px at 50% 26%, rgba(250,247,242,0.62), rgba(250,247,242,0.28) 55%, transparent 78%)',
                }}
              />
              {/* Top fade — the page's very first pixel row is solid
                  cream, matching the themeColor that mobile Safari paints
                  its status-bar chrome with, so browser chrome dissolves
                  into the mesh instead of meeting it at a hard white
                  edge. Short ramp: fully gone before the headline. */}
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-28 pointer-events-none md:hidden"
                style={{
                  background:
                    'linear-gradient(to bottom, rgba(250,247,242,1) 0%, rgba(250,247,242,0.5) 45%, rgba(250,247,242,0) 100%)',
                }}
              />
              {/* Bottom fade — dissolves the mesh into the next section's
                  cream. Long ramp (22vh) so it doesn't feel like a strip,
                  ending at full opacity so the seam against the solid
                  cream below disappears entirely. */}
              <div
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-[22vh] pointer-events-none"
                style={{
                  background:
                    'linear-gradient(to bottom, rgba(250,247,242,0) 0%, rgba(250,247,242,0.15) 40%, rgba(250,247,242,0.55) 75%, rgba(250,247,242,1) 100%)',
                }}
              />
            </>
          )}
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
              className="hidden sm:inline-flex items-center gap-1.5 bg-near-black text-cream font-logo font-semibold px-5 py-2 rounded-full text-[14px] hover:bg-near-black/90 transition-all shadow-[0_4px_14px_-6px_rgba(14,26,26,0.35)] hover:-translate-y-px active:translate-y-0"
            >
              Hire Caye
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
                onClick={() => setMobileMenuOpen(false)}
                className="block mt-1 px-4 py-3 rounded-2xl text-[16px] font-logo font-semibold bg-near-black text-cream text-center"
              >
                Hire Caye
              </a>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Hero content — top padding compensates for the nav now being
            `fixed` (out of flow) instead of sitting in-line above this,
            so it clears the floating pill instead of sliding under it. */}
        <div className="relative z-10 flex-1 flex flex-col items-center px-6 pt-28 md:pt-32">
          <div className="max-w-3xl mx-auto text-center">
            {/* Headline — trial #4: Geist, at black weight, one short
                line. Trials #2 (Bricolage) and #3 (Bodoni Moda) both hit
                a legibility ceiling that isn't about weight or size —
                it's stroke contrast and line count.

                Trial #5: swapped Geist (font-sans) for Fraunces
                (font-logo) per feedback that the text's edges read too
                sharp/geometric at this weight. Fraunces has soft, round
                bowls and ball terminals — same family already used for
                the "caye" wordmark in the nav, so the headline (which
                literally says "Caye") now renders in the same face as
                the logo itself instead of a harder technical grotesque.

                Copy: user's own pick, simplified — name-first ("Meet
                Caye.") only, one tier, not stacked with a second
                supporting line ("too many subheadings" per feedback).
                The dropped supporting line ("The teammate your business
                has been waiting for.") moved to its own big-statement
                section further down the page instead — same beat Viktor
                uses (hero, then a second bold reinforcing statement
                later in the scroll), just not stacked in the hero
                itself. */}
            <motion.h1
              {...heroItem(0.18)}
              className="font-logo text-[3rem] sm:text-6xl md:text-[5.5rem] lg:text-[6.5rem] font-extrabold tracking-[-0.03em] text-near-black leading-[1.05]"
            >
              Meet <span className="text-caribbean-teal-deep">Caye.</span>
            </motion.h1>

            {/* Subhead — Newsreader editorial deck */}
            <motion.p
              {...heroItem(0.34)}
              className="mt-8 font-newsreader text-[1.2rem] md:text-[1.35rem] leading-[1.45] text-near-black/85 max-w-2xl mx-auto font-light"
              style={{ fontStyle: 'normal' }}
            >
              Talk to Caye in WhatsApp. She answers customers, manages operations, and gets work done across your business.
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
                className="group relative inline-flex items-center gap-2.5 bg-near-black text-cream font-logo font-semibold px-9 py-4 rounded-full text-[16px] hover:bg-near-black/90 transition-all shadow-[0_4px_20px_-6px_rgba(14,26,26,0.25)] hover:shadow-[0_8px_28px_-8px_rgba(14,26,26,0.35)] hover:-translate-y-[1px] active:translate-y-0"
              >
                <span>Try Caye free</span>
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
              <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-near-black/70">
                Free for 7 days · No credit card
              </p>

              {/* Channel badge — sits just above the phone dock, the same
                  beat Viktor uses for its Slack/Teams toggle right above
                  its chat screenshot: name the surface she actually lives
                  in, right before you show it. WhatsApp only (not the
                  full integration list from the strip below) because
                  this is about where she lives, not everywhere she's
                  plugged in. In normal document flow (not absolutely
                  positioned off a guessed pixel offset) so it can never
                  overlap or float away from the CTA text above it. */}
              <div className="mt-3 flex items-center gap-2 rounded-full border border-near-black/15 bg-white/60 backdrop-blur-sm px-4 py-2 shadow-[0_4px_16px_-8px_rgba(14,26,26,0.15)]">
                <span
                  className="flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0"
                  style={{ background: '#25D366' }}
                  aria-hidden
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.36 5.07L2 22l5.1-1.33A9.94 9.94 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2Zm5.2 14.13c-.22.62-1.29 1.19-1.78 1.24-.46.06-1.02.08-1.65-.1a13.6 13.6 0 0 1-5.8-4.09 6.6 6.6 0 0 1-1.4-3.36c0-.9.47-1.34.64-1.52.17-.18.37-.22.5-.22h.36c.12 0 .28-.02.43.34.16.4.55 1.4.6 1.5.05.1.08.22.02.36-.06.13-.09.22-.19.34l-.28.33c-.09.1-.19.2-.08.4.11.2.5.86 1.09 1.4.75.68 1.4.9 1.6 1 .2.1.32.09.44-.05.13-.14.51-.6.65-.8.14-.2.27-.17.46-.1.19.07 1.2.58 1.4.68.2.1.34.15.39.24.05.09.05.5-.17 1.11Z"
                      fill="#fff"
                    />
                  </svg>
                </span>
                <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-near-black/80 font-medium">
                  Live, right now, in WhatsApp
                </span>
              </div>
            </motion.div>
          </div>

        </div>

        {/* Phone dock — the real product surface, live in the hero. The
            section is sized (see heroMinHeight) to always fully contain
            it, so it's never clipped mid-conversation — it just sits
            below the initial fold on shorter viewports, inviting a
            scroll, and its ground shadow dissolves into the next
            section's cream via the fade below. */}
        <motion.div
          initial={{ opacity: 0, y: 46 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: heroEase, delay: 0.62 }}
          className="absolute left-1/2 -translate-x-1/2 z-10"
          style={{ top: phoneTopOffset }}
        >
          <div className="origin-top" style={{ transform: `scale(${phoneScale})` }}>
            <WhatsAppMockup />
          </div>
        </motion.div>

        {/* Dissolve fade — sits above the phone's ground shadow (z-20) so
            the bottom of the section melts into the next section's cream
            instead of a hard seam. Generous height since it only needs to
            cover the phone's shadow/margin now, not any real content. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[16vh] md:h-[18vh] pointer-events-none z-20"
          style={{
            background:
              'linear-gradient(to bottom, rgba(250,247,242,0) 0%, rgba(250,247,242,0.3) 45%, rgba(250,247,242,0.8) 75%, rgba(250,247,242,1) 100%)',
          }}
        />
      </section>

      {/* ── Reinforcing statement — the beat Viktor uses right after
          its hero/logo bar: a second, bigger bold statement further
          down the scroll instead of stacking a supporting line under
          the hero headline. No logo bar precedes this one (one real
          customer, no fabricated "used by" claim), so it follows the
          hero directly. Self-contained sentence (names Caye) since it
          no longer sits right under the hero for context. ── */}
      <section className="relative py-24 md:py-32 px-6 bg-cream text-center">
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.7, ease: heroEase }}
          className="font-logo text-[2rem] sm:text-4xl md:text-[3.25rem] font-extrabold tracking-[-0.02em] leading-[1.15] text-near-black max-w-3xl mx-auto"
        >
          Caye is the teammate your business
          <br />
          <span className="text-caribbean-teal-deep">has been waiting for.</span>
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.6, ease: heroEase, delay: 0.15 }}
          className="mt-9"
        >
          <a
            href={CAYE_SIGNUP_WA_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-2.5 bg-near-black text-cream font-logo font-semibold px-9 py-4 rounded-full text-[16px] hover:bg-near-black/90 transition-all shadow-[0_4px_20px_-6px_rgba(14,26,26,0.25)] hover:-translate-y-[1px] active:translate-y-0"
          >
            <span>Try Caye free</span>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="transition-transform group-hover:translate-x-1">
              <path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </motion.div>
      </section>

      {/* ── Channel strip — front desk vs. back office ────────────── */}
      <section id="channels" className="relative py-20 px-6 bg-cream border-y border-near-black/[0.06] scroll-mt-24">
        <div className="max-w-2xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, ease: heroEase }}
            className="flex items-center justify-center gap-3 mb-8"
          >
            <span className="h-px w-8 bg-near-black/30" />
            <h2 className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/60 font-medium">
              Where she works
            </h2>
            <span className="h-px w-8 bg-near-black/30" />
          </motion.div>

          {/* Front desk — the surfaces she actually talks to customers
              through. Real brand marks, small and grouped as chips, so
              they read as proof rather than a decorative row. */}
          <div className="flex flex-wrap items-center justify-center gap-3">
            {FRONT_DESK_CHANNELS.map(({ label, Icon, bg, color }, i) => (
              <motion.span
                key={label}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.5, ease: heroEase, delay: 0.1 + i * 0.08 }}
                className="inline-flex items-center gap-2 rounded-full pl-2.5 pr-4 py-2 border border-near-black/[0.08] bg-white/50 backdrop-blur-sm"
              >
                <span
                  className="flex items-center justify-center w-6 h-6 rounded-full flex-shrink-0"
                  style={{ background: bg }}
                >
                  <Icon size={14} weight="fill" color={color} />
                </span>
                <span className="font-newsreader text-[15px] text-near-black/80">
                  {label}
                </span>
              </motion.span>
            ))}
          </div>

          {/* Rolling out — Instagram/Messenger webhooks are built but not
              yet proven end-to-end, so they're named honestly as "next"
              rather than given equal billing with WhatsApp above. */}
          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, ease: heroEase, delay: 0.3 }}
            className="mt-6 font-newsreader italic text-[14px] text-near-black/40"
          >
            Instagram and Messenger are rolling out next.
          </motion.p>

          {/* Back office — quiet on purpose. She reads and writes here;
              she doesn't hold a conversation through them, so they don't
              compete visually with the front-desk row above. Zoho Mail
              is the one proven email channel today — kept channel-
              agnostic on calendar rather than naming Gmail/Google
              Calendar, since neither is confirmed live yet. */}
          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, ease: heroEase, delay: 0.4 }}
            className="mt-3 font-newsreader italic text-[14px] text-near-black/40"
          >
            Quietly reads and writes to Zoho Mail and your calendar too.
          </motion.p>
        </div>
      </section>

      {/* ── FAQ — static (no accordion) so the full text is in the
          initial HTML for crawlers and AI answer engines, not hidden
          behind a click. Copy is mirrored into FAQPage JSON-LD in
          app/page.tsx; keep FAQ_ITEMS as the single source of truth. ── */}
      <section id="faq" className="relative py-20 px-6 bg-cream scroll-mt-24">
        <div className="max-w-2xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, ease: heroEase }}
            className="flex items-center justify-center gap-3 mb-12"
          >
            <span className="h-px w-8 bg-near-black/30" />
            <h2 className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/60 font-medium">
              Questions
            </h2>
            <span className="h-px w-8 bg-near-black/30" />
          </motion.div>

          <div className="space-y-10">
            {FAQ_ITEMS.map((item, i) => (
              <motion.div
                key={item.q}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.5, ease: heroEase, delay: i * 0.06 }}
              >
                <h3 className="font-instrument text-[1.3rem] md:text-[1.45rem] tracking-[-0.01em] text-near-black leading-snug">
                  {item.q}
                </h3>
                <p className="mt-2.5 font-newsreader text-[15.5px] leading-[1.6] text-near-black/70">
                  {item.a}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Proof — first paid-customer quote goes here ──────────────
          Slot is built and styled; flip `SHOW_TESTIMONIAL` to true and
          drop in the real quote + attribution once a pilot converts to
          paid. No fabricated praise before then.

          Visual device borrowed from Viktor's case-study page: a glass
          card physically overlapping a saturated gradient band into the
          flat page below it. Kept Caye's own palette rather than
          Viktor's violet — this reuses the exact same mesh gradient as
          the hero, just condensed, so it reads as this brand's own
          bookend (opens on the mesh, closes on it) instead of a
          borrowed look. */}
      {SHOW_TESTIMONIAL && (
        <section className="relative overflow-hidden bg-cream">
          <div className="relative h-[240px] md:h-[300px] overflow-hidden">
            {mounted && (
              <div className="absolute inset-0">
                <MeshGradient
                  width={dimensions.width}
                  height={320}
                  colors={HERO_COLORS}
                  distortion={0.6}
                  swirl={0.45}
                  grainMixer={0}
                  grainOverlay={0}
                  speed={0.3}
                  offsetX={0.2}
                />
                <div className="absolute inset-0 bg-cream/10" />
              </div>
            )}
            {/* Dissolve into the cream below — the card overlaps this
                fade, same trick as the hero's own bottom fade. */}
            <div
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-2/3 pointer-events-none"
              style={{
                background:
                  'linear-gradient(to bottom, rgba(250,247,242,0) 0%, rgba(250,247,242,0.6) 60%, rgba(250,247,242,1) 100%)',
              }}
            />
          </div>

          <motion.figure
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.7, ease: heroEase }}
            className="relative z-10 max-w-2xl mx-auto px-6 md:px-10 py-12 md:py-14 -mt-[100px] md:-mt-[140px] pb-16 md:pb-24 rounded-[2.25rem] border border-near-black/[0.06] bg-cream/95 backdrop-blur-md shadow-[0_30px_70px_-24px_rgba(14,26,26,0.28)] text-center"
          >
            {/* Ambient glow bleeding out from behind the card — echoes
                the gradient band above instead of a flat drop shadow */}
            <span
              aria-hidden
              className="absolute -inset-8 -z-10 rounded-[3rem] opacity-60 blur-3xl"
              style={{
                background:
                  'radial-gradient(60% 60% at 30% 0%, rgba(7,102,163,0.28), transparent 70%), radial-gradient(50% 50% at 80% 10%, rgba(255,228,175,0.4), transparent 70%)',
              }}
            />

            <div className="flex items-center justify-center gap-3 mb-8">
              <span className="h-px w-8 bg-near-black/25" />
              <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/60 font-medium">
                From the dock
              </span>
              <span className="h-px w-8 bg-near-black/25" />
            </div>
            <blockquote className="font-instrument text-[1.7rem] md:text-[2.1rem] leading-[1.18] tracking-[-0.015em] text-near-black">
              “{TESTIMONIAL.quote}”
            </blockquote>
            <figcaption className="mt-7 font-mono text-[10.5px] uppercase tracking-[0.18em] text-near-black/55">
              {TESTIMONIAL.name} · {TESTIMONIAL.business}
            </figcaption>
          </motion.figure>
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
                Not a tool. A hire. The one who runs your front desk from
                your own WhatsApp.
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
