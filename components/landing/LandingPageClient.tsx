'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { MeshGradient } from '@paper-design/shaders-react'
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
  SparkleIcon,
  CaretDownIcon,
} from '@phosphor-icons/react'
import { sendGAEvent } from '@next/third-parties/google'
import WhatsAppMockup from '@/components/landing/WhatsAppMockup'
import { FAQ_ITEMS } from '@/components/landing/faq-data'

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

// Suppress unused-vars warnings — these are intentional toggles.
void PALETTE_SOFT
void PALETTE_SUNSET
void PALETTE_REEF

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
  const [dimensions, setDimensions] = useState({ width: 1920, height: 1080 })
  const [mounted, setMounted] = useState(false)
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

  // Phone dock's top offset — floor keeps it clear of the CTA block (now
  // including the WhatsApp badge, which lives in normal document flow
  // right below the CTA text rather than at a guessed absolute pixel
  // offset) on short viewports; the 0.6 factor pulls it toward the fold
  // on taller viewports so it doesn't sit awkwardly high with empty
  // space beneath it.
  const phoneTopOffset = Math.max(620, dimensions.height * 0.6)

  // Phone grows a bit on wider screens — purely a size choice now, not
  // constrained by a crop budget (see heroMinHeight below). Mobile tier
  // bumped from 0.75 → 0.95 per feedback that the phone read too small
  // to comfortably read the demo conversation or tap the reply chips on
  // an actual phone screen — safe to push this close to 1 since
  // PhoneFrame's own width is already clamped to `100vw - 40px` before
  // this scale is applied, so a 20px gutter on each side is guaranteed
  // regardless of how close to 1 this gets.
  const phoneScale =
    dimensions.width >= 1024
      ? 1.05
      : dimensions.width >= 768
        ? 0.95
        : dimensions.width >= 640
          ? 0.85
          : 0.95

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
              onClick={() => trackSignupClick('nav')}
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
                onClick={() => {
                  trackSignupClick('mobile_menu')
                  setMobileMenuOpen(false)
                }}
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
                onClick={() => trackSignupClick('hero')}
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
            onClick={() => trackSignupClick('mid_page')}
            className="group inline-flex items-center gap-2.5 bg-near-black text-cream font-logo font-semibold px-9 py-4 rounded-full text-[16px] hover:bg-near-black/90 transition-all shadow-[0_4px_20px_-6px_rgba(14,26,26,0.25)] hover:-translate-y-[1px] active:translate-y-0"
          >
            <span>Try Caye free</span>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="transition-transform group-hover:translate-x-1">
              <path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
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
                      <SparkleIcon size={13} weight="fill" color="#0D9C8B" />
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
