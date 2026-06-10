'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MeshGradient } from '@paper-design/shaders-react'
import { CayeLogo } from '@/components/brand/CayeLogo'
import { DashboardMockup } from '@/components/landing/DashboardMockup'

// Simplified landing — credibility surface, not a conversion engine.
// Primary CTA goes straight to a demo request (lamar@tropitech.org).
// Self-serve signup is quiet in the footer until embedded-signup ships.
//
// Typography:
//   Headline   — Instrument Serif (editorial display, italic accent)
//   Subhead    — Newsreader light (editorial deck/subtitle, pairs with Instrument)
//   Eyebrow    — JetBrains Mono uppercase (editorial dateline)
//   Body / nav — Geist (sans, product-UI default)

const HERO_COLORS = ['#72b9bb', '#b5d9d9', '#ffd1bd', '#ffebe0', '#8cc5b8', '#dbf4a4']

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
            className="text-[13px] font-medium text-near-black/80 hover:text-near-black transition-colors px-4 py-2 rounded-full hover:bg-white/40"
          >
            Log in
          </Link>
        </header>

        {/* Hero content */}
        <div className="relative z-10 flex-1 flex items-center justify-center px-6">
          <div className="max-w-3xl mx-auto text-center pb-24">
            {/* Eyebrow — editorial dateline */}
            <div className="flex items-center justify-center gap-3 mb-10">
              <span className="h-px w-8 bg-near-black/30" />
              <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/60 font-medium">
                Meet Caye
              </span>
              <span className="h-px w-8 bg-near-black/30" />
            </div>

            {/* Headline */}
            <h1
              className="font-instrument text-[3.5rem] sm:text-7xl md:text-[5.5rem] lg:text-[6.5rem] font-normal tracking-[-0.028em] text-near-black leading-[0.98]"
              style={{ WebkitTextStroke: '0.4px currentColor' }}
            >
              Your AI{' '}
              <span className="italic text-caribbean-teal-deep relative inline-block">
                front desk
                <svg
                  aria-hidden="true"
                  viewBox="0 0 200 12"
                  preserveAspectRatio="none"
                  className="absolute -bottom-1 left-0 w-full h-[10px] text-caribbean-teal-deep/40"
                >
                  <path
                    d="M2 8 C 40 2, 80 10, 120 5 S 180 8, 198 4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              .
            </h1>

            {/* Subhead — Newsreader editorial deck */}
            <p
              className="mt-9 font-newsreader text-[1.25rem] md:text-[1.4rem] leading-[1.45] text-near-black/75 max-w-xl mx-auto font-light"
              style={{ fontStyle: 'normal' }}
            >
              She answers, quotes, and books — across every channel you use.
            </p>

            {/* Primary CTA */}
            <div className="mt-12 flex flex-col items-center gap-4">
              <a
                href="mailto:lamar@tropitech.org?subject=Caye%20demo"
                className="group relative inline-flex items-center gap-2.5 bg-near-black text-cream font-medium px-9 py-4 rounded-full text-[15px] hover:bg-near-black/90 transition-all shadow-[0_4px_20px_-6px_rgba(14,26,26,0.25)] hover:shadow-[0_8px_28px_-8px_rgba(14,26,26,0.35)] hover:-translate-y-[1px] active:translate-y-0"
              >
                <span>Get a demo</span>
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
              <p className="font-newsreader italic text-[14px] text-near-black/55">
                A 20-minute walkthrough with Lamar — no slides, just the product.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Dashboard mockup ─────────────────────────────────────── */}
      <DashboardMockup />

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
