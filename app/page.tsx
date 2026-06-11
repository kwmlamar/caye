'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { MeshGradient } from '@paper-design/shaders-react'
import { CayeLogo } from '@/components/brand/CayeLogo'
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
      <section className="relative min-h-screen overflow-hidden flex flex-col">
        {/* Mesh gradient background */}
        <div className="absolute inset-0 w-full h-full">
          {mounted && (
            <>
              <MeshGradient
                width={dimensions.width}
                height={dimensions.height}
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
            <CayeLogo size={26} />
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center text-[13px] font-medium text-near-black border border-near-black/20 bg-white/40 backdrop-blur-sm px-5 py-2 rounded-full hover:bg-white/70 hover:border-near-black/35 transition-all"
          >
            Log in
          </Link>
        </header>

        {/* Hero content */}
        <div className="relative z-10 flex-1 flex items-center justify-center px-6">
          <div className="max-w-3xl mx-auto text-center pb-24">
            {/* Eyebrow — editorial dateline */}
            <motion.div
              {...heroItem(0.05)}
              className="flex items-center justify-center gap-3 mb-10"
            >
              <span className="h-px w-8 bg-near-black/30" />
              <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/60 font-medium">
                Meet Caye
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
              className="mt-9 font-newsreader text-[1.2rem] md:text-[1.35rem] leading-[1.45] text-near-black/75 max-w-2xl mx-auto font-light"
              style={{ fontStyle: 'normal' }}
            >
              Caye answers customers, quotes prices, and books in your voice. No
              app to learn. No workflows to build. Just text her like an
              employee.
            </motion.p>

            {/* Primary CTA */}
            <motion.div
              {...heroItem(0.5)}
              className="mt-12 flex flex-col items-center gap-3"
            >
              <Link
                href="/signup"
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
              </Link>
              <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-near-black/55">
                Free for 7 days · No credit card
              </p>
              <a
                href="mailto:lamar@tropitech.org?subject=Caye%20walkthrough"
                className="font-newsreader italic text-[14px] text-near-black/55 hover:text-near-black/80 transition-colors mt-1"
              >
                Prefer a walkthrough? Email Lamar →
              </a>
            </motion.div>
          </div>
        </div>

        {/* Scroll affordance — quiet pulse at the bottom of the hero so
            visitors know there's content below the fold. */}
        <div className="absolute inset-x-0 bottom-8 flex justify-center z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-near-black/55 animate-[bob_2.4s_ease-in-out_infinite]">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.22em]">
              Scroll
            </span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              aria-hidden
            >
              <path
                d="M7 2.5v9M3.5 8 7 11.5 10.5 8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      </section>

      {/* ── Channel strip — install-and-go proof ─────────────────── */}
      <section className="relative py-14 px-6 bg-cream border-y border-near-black/[0.06]">
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

      {/* ── WhatsApp mockup — daily operator surface ─────────────── */}
      <WhatsAppMockup />

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

      {/* ── From-the-islands credibility — watercolor band ────────── */}
      <section className="relative overflow-hidden">
        <motion.img
          src="/island-watercolor.jpg"
          alt=""
          aria-hidden
          loading="lazy"
          initial={{ scale: 1.06 }}
          whileInView={{ scale: 1 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 1.6, ease: heroEase }}
          className="w-full h-[300px] md:h-[400px] object-cover"
        />
        {/* Cream fades so the band sits in the page instead of on it */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-20 pointer-events-none"
          style={{
            background:
              'linear-gradient(to bottom, rgba(250,247,242,1) 0%, rgba(250,247,242,0) 100%)',
          }}
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-20 pointer-events-none"
          style={{
            background:
              'linear-gradient(to top, rgba(250,247,242,1) 0%, rgba(250,247,242,0) 100%)',
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.7, ease: heroEase, delay: 0.2 }}
            className="font-newsreader italic text-[18px] md:text-[20px] text-near-black/80 max-w-lg text-center leading-relaxed rounded-2xl px-7 py-5 bg-cream/70 backdrop-blur-[6px] shadow-[0_8px_30px_-12px_rgba(14,26,26,0.18)]"
          >
            By a founder from Eleuthera. Built for the operators he grew up
            next to.
          </motion.p>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-near-black/[0.08] bg-cream/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-7 flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-near-black/50 font-medium">
            © 2026 Caye by TropiTech · Built in Nassau, Bahamas
          </span>
          <nav className="flex items-center gap-6 text-[13px] text-near-black/55">
            <a
              href="mailto:lamar@tropitech.org?subject=Caye"
              className="hover:text-near-black transition-colors"
            >
              Contact
            </a>
            <Link href="/signup" className="hover:text-near-black transition-colors">
              Sign up
            </Link>
            <Link href="/login" className="hover:text-near-black transition-colors">
              Log in
            </Link>
            <Link href="/terms" className="hover:text-near-black transition-colors">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-near-black transition-colors">
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
