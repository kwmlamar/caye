'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { MeshGradient } from '@paper-design/shaders-react'
import WhatsAppMockup from '@/components/landing/WhatsAppMockup'

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
const PALETTE_DEEP = ['#00778B', '#7DC9CB', '#FFD68F', '#F5E8D0', '#A8DCC0', '#F4E3A0']
// Sunset / golden hour — warmer, more sand/coral, less green:
const PALETTE_SUNSET = ['#3A8B98', '#A8D5D5', '#FFC4A0', '#FFE5D0', '#FFD68F', '#FFB5A8']
// Reef + water — vivid snorkel palette, deepest contrast:
const PALETTE_REEF = ['#2E7A8C', '#6DC4C9', '#FFD580', '#F5E8D0', '#A8DCC0', '#FF9B85']

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

export default function LandingPage() {
  const [dimensions, setDimensions] = useState({ width: 1920, height: 1080 })
  const [mounted, setMounted] = useState(false)

  // Phone dock's top offset — floor keeps it clear of the CTA block
  // (fixed ~590px tall regardless of viewport height) on short viewports;
  // the 0.6 factor pulls it toward the fold on taller ones so it doesn't
  // sit awkwardly high with empty space beneath it.
  const phoneTopOffset = Math.max(630, dimensions.height * 0.6)

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

        {/* Top bar */}
        <header className="relative z-10 max-w-7xl w-full mx-auto px-6 md:px-12 py-7 flex items-center justify-between">
          <Link href="/" className="flex items-center select-none">
            <span className="font-logo font-semibold tracking-tight text-[#0E1A1A]" style={{ fontSize: 22 }}>
              caye
            </span>
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center text-[13px] font-medium text-near-black border border-near-black/20 bg-white/40 backdrop-blur-sm px-5 py-2 rounded-full hover:bg-white/70 hover:border-near-black/35 transition-all"
          >
            Log in
          </Link>
        </header>

        {/* Hero content */}
        <div className="relative z-10 flex-1 flex flex-col items-center px-6 pt-2 md:pt-6">
          <div className="max-w-3xl mx-auto text-center">
            {/* Eyebrow — editorial dateline */}
            <motion.div
              {...heroItem(0.05)}
              className="flex items-center justify-center gap-3 mb-8"
            >
              <span className="h-px w-8 bg-near-black/30" />
              <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/60 font-medium">
                Not a tool. A hire.
              </span>
              <span className="h-px w-8 bg-near-black/30" />
            </motion.div>

            {/* Headline */}
            <motion.h1
              {...heroItem(0.18)}
              className="font-instrument text-[2.75rem] sm:text-5xl md:text-[4.25rem] lg:text-[5rem] font-normal tracking-[-0.026em] text-near-black leading-[1.02]"
              style={{ WebkitTextStroke: '0.4px currentColor' }}
            >
              She handles your DMs.
              <br />
              <span className="italic text-caribbean-teal-deep">
                You handle your business.
              </span>
            </motion.h1>

            {/* Subhead — Newsreader editorial deck */}
            <motion.p
              {...heroItem(0.34)}
              className="mt-8 font-newsreader text-[1.2rem] md:text-[1.35rem] leading-[1.45] text-near-black/75 max-w-2xl mx-auto font-light"
              style={{ fontStyle: 'normal' }}
            >
              Caye answers, quotes, and books. The AI staff member that lives
              in your WhatsApp.
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
                className="group relative inline-flex items-center gap-2.5 bg-near-black text-cream font-medium px-9 py-4 rounded-full text-[15px] hover:bg-near-black/90 transition-all shadow-[0_4px_20px_-6px_rgba(14,26,26,0.25)] hover:shadow-[0_8px_28px_-8px_rgba(14,26,26,0.35)] hover:-translate-y-[1px] active:translate-y-0"
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
              <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-near-black/55">
                Free for 7 days · No credit card
              </p>
            </motion.div>
          </div>

        </div>

        {/* Channel badge — sits just above the phone dock, the same beat
            Viktor uses for its Slack/Teams toggle right above its chat
            screenshot: name the surface she actually lives in, right
            before you show it. WhatsApp only (not the full integration
            list from the strip below) because this is about where she
            lives, not everywhere she's plugged in. */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: heroEase, delay: 0.56 }}
          className="absolute left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-full border border-near-black/15 bg-white/60 backdrop-blur-sm px-4 py-2 shadow-[0_4px_16px_-8px_rgba(14,26,26,0.15)]"
          style={{ top: phoneTopOffset - 44 }}
        >
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
          <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-near-black/70 font-medium">
            Live, right now, in WhatsApp
          </span>
        </motion.div>

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

      {/* ── Channel strip — install-and-go proof ─────────────────── */}
      <section id="channels" className="relative py-14 px-6 bg-cream border-y border-near-black/[0.06]">
        <div className="max-w-4xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, ease: heroEase }}
            className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/55 font-medium mb-5"
          >
            Plays with the lines you already use
          </motion.div>
          <div className="flex items-center justify-center gap-x-5 gap-y-2 flex-wrap text-near-black/70">
            {[
              'WhatsApp',
              'Instagram',
              'Messenger',
              'Zoho Mail',
              'Gmail',
              'Google Calendar',
            ].map((label, i, arr) => (
              <motion.span
                key={label}
                initial={{ opacity: 0, y: 8 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{
                  duration: 0.5,
                  ease: heroEase,
                  delay: 0.12 + i * 0.07,
                }}
                className="flex items-center gap-x-5"
              >
                <span className="font-newsreader text-[16px]">{label}</span>
                {i < arr.length - 1 && (
                  <span className="text-near-black/30">·</span>
                )}
              </motion.span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Proof — first paid-customer quote goes here ──────────────
          Slot is built and styled; flip `SHOW_TESTIMONIAL` to true and
          drop in the real quote + attribution once a pilot converts to
          paid. No fabricated praise before then. */}
      {SHOW_TESTIMONIAL && (
        <section className="relative py-24 px-6 bg-cream">
          <motion.figure
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.7, ease: heroEase }}
            className="max-w-2xl mx-auto text-center"
          >
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
                <img src="/brand/caye-orb.svg" alt="" aria-hidden className="w-5 h-5" />
                <span className="font-logo font-semibold tracking-tight text-near-black text-[22px]">
                  caye
                </span>
              </div>
              <p className="mt-4 font-newsreader text-[15px] leading-relaxed text-near-black/60 max-w-[240px]">
                Not a tool. A hire. The AI staff member that lives in your
                WhatsApp.
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
              © 2026 Caye by TropiTech · Built in Nassau, Bahamas
            </span>
          </div>
        </div>

        {/* Sign-painted wordmark — the family-island welcome-sign move
            (ELEUTHERA-style hand-lettered block signage: a vivid paint
            gradient) reinterpreted in the hero's own sunset-over-sea
            palette. Full-bleed (outside the 7xl container) so it has the
            whole viewport to scale into. Deliberately cropped to the
            page's own bottom edge (viktor.com's move) — the crop height
            is tied to the same clamp() driving the font-size via calc(),
            so the ratio holds at every breakpoint instead of clipping
            unpredictably. */}
        <div
          aria-hidden
          className="select-none pointer-events-none overflow-hidden flex items-start justify-center gap-3 md:gap-5 px-4 pt-6"
          style={{
            maxHeight: 'calc(clamp(6rem, 30vw, 26rem) * 0.62)',
            background:
              'linear-gradient(180deg, transparent 0%, rgba(168,220,192,0.14) 100%)',
          }}
        >
          <span className="h-px w-6 md:w-12 bg-near-black/15 flex-shrink-0 mt-[0.55em]" />
          <span
            className="text-center font-logo font-bold whitespace-nowrap"
            style={{
              fontSize: 'clamp(6rem, 30vw, 26rem)',
              lineHeight: 1.15,
              backgroundImage:
                'linear-gradient(180deg, #FFD68F 0%, #F4E3A0 24%, #A8DCC0 52%, #7DC9CB 76%, #00778B 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            caye
          </span>
          <span className="h-px w-6 md:w-12 bg-near-black/15 flex-shrink-0 mt-[0.55em]" />
        </div>
      </footer>
    </div>
  )
}
