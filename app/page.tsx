'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MeshGradient } from '@paper-design/shaders-react'
import { CayeLogo } from '@/components/brand/CayeLogo'

// Simplified landing — credibility surface, not a conversion engine.
// Primary CTA goes straight to a demo request (lamar@tropitech.org).
// Self-serve signup is quiet in the footer until embedded-signup ships.

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

  return (
    <div className="min-h-screen flex flex-col bg-cream text-near-black font-sans selection:bg-caribbean-teal selection:text-white">
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="relative flex-1 min-h-screen overflow-hidden flex flex-col">
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
              <div className="absolute inset-0 pointer-events-none bg-cream/15" />
            </>
          )}
        </div>

        {/* Top bar */}
        <header className="relative z-10 max-w-7xl w-full mx-auto px-6 md:px-12 py-6 flex items-center justify-between">
          <Link href="/" className="flex items-center select-none">
            <CayeLogo size={26} />
          </Link>
          <Link
            href="/login"
            className="text-[13.5px] font-medium text-near-black/80 hover:text-near-black transition-colors px-4 py-2 rounded-full hover:bg-white/40"
          >
            Log in
          </Link>
        </header>

        {/* Hero content */}
        <div className="relative z-10 flex-1 flex items-center justify-center px-6">
          <div className="max-w-3xl mx-auto text-center space-y-7 pb-24">
            <span className="inline-flex items-center gap-2 bg-white/40 backdrop-blur-sm text-caribbean-teal-deep border border-white/60 px-3.5 py-1 rounded-full text-xs font-mono uppercase font-semibold tracking-wider">
              Meet Caye
            </span>

            <h1
              className="font-instrument text-5xl sm:text-6xl md:text-7xl lg:text-[5.5rem] font-normal tracking-[-0.022em] text-near-black leading-[1.02]"
              style={{ WebkitTextStroke: '0.6px currentColor' }}
            >
              Your AI{' '}
              <span className="italic text-caribbean-teal-deep">front desk</span>.
            </h1>

            <p className="text-lg md:text-xl leading-snug text-near-black/85 max-w-xl mx-auto font-medium">
              She answers, quotes, and books — across every channel you use.
            </p>

            <div className="pt-3 flex flex-col items-center gap-3">
              <a
                href="mailto:lamar@tropitech.org?subject=Caye%20demo"
                className="inline-flex items-center justify-center bg-near-black text-cream font-medium px-8 py-3.5 rounded-xl hover:bg-near-black/90 transition-all text-base hover:scale-[1.01] active:scale-[0.99] shadow-[0_4px_20px_-6px_rgba(14,26,26,0.25)]"
              >
                Get a demo
              </a>
              <p className="text-[12.5px] text-near-black/70 font-mono tracking-tight">
                A 20-minute walkthrough with Lamar — no slides, just the product.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-near-black/[0.08] bg-cream/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="text-[12.5px] text-near-black/55 font-mono tracking-tight">
            © 2026 Caye by TropiTech. Built in Nassau, Bahamas.
          </span>
          <nav className="flex items-center gap-5 text-[12.5px] text-near-black/55">
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
