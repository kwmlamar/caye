'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import FeatureSection from '@/components/landing/FeatureSection'
import { CayeLogo } from '@/components/brand/CayeLogo'

export default function LandingPage() {
  const [activeFaq, setActiveFaq] = useState<number | null>(null)
  const [billing, setBilling] = useState<'monthly' | 'annual'>('monthly')
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 30)
    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const pricing = {
    caye: {
      monthly: { display: '$79', cadence: '/ month', footnote: null as string | null },
      annual: { display: '$790', cadence: '/ year', footnote: 'Just $66/mo, billed yearly · two months free' },
    },
    bundle: {
      monthly: { display: '$129', cadence: '/ month', footnote: null as string | null },
      annual: { display: '$1,290', cadence: '/ year', footnote: 'Just $108/mo, billed yearly · two months free' },
    },
  } as const

  useEffect(() => {
    document.body.classList.add('lp-body')
    return () => { document.body.classList.remove('lp-body') }
  }, [])

  const toggleFaq = (index: number) => {
    setActiveFaq(activeFaq === index ? null : index)
  }

  return (
    <div className="min-h-screen bg-cream text-near-black font-sans selection:bg-caribbean-teal selection:text-white relative">
      {/* Background radial highlights */}
      <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute top-[-10%] right-[10%] w-[800px] h-[600px] rounded-full bg-caribbean-teal/5 blur-[120px]" />
      </div>

      {/* Navigation — fixed, transparent over hero, solid cream once scrolled */}
      <header
        className={`fixed top-0 inset-x-0 z-50 transition-colors duration-300 ${
          scrolled ? 'bg-cream border-b border-near-black/[0.06]' : 'bg-transparent'
        }`}
      >
        <div className="max-w-7xl mx-auto px-6 md:px-12 h-20 flex items-center justify-between">
          {/* Brand — wordmark left, small but present */}
          <Link href="/" className="flex items-center select-none group">
            <CayeLogo size={26} />
          </Link>

          {/* Nav — mono caps, editorial label energy */}
          <nav className="hidden md:flex items-center gap-10">
            <a href="#how" className="font-mono text-[10.5px] tracking-[0.22em] uppercase font-semibold text-near-black/55 hover:text-near-black transition-colors">
              How it works
            </a>
            <a href="#features" className="font-mono text-[10.5px] tracking-[0.22em] uppercase font-semibold text-near-black/55 hover:text-near-black transition-colors">
              For operators
            </a>
            <a href="#pricing" className="font-mono text-[10.5px] tracking-[0.22em] uppercase font-semibold text-near-black/55 hover:text-near-black transition-colors">
              Pricing
            </a>
          </nav>

          {/* Actions — refined, low chrome */}
          <div className="flex items-center gap-5">
            <Link
              href="/login"
              className="hidden sm:inline font-mono text-[10.5px] tracking-[0.22em] uppercase font-semibold text-near-black/55 hover:text-near-black transition-colors"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="inline-flex items-center justify-center bg-near-black text-cream font-medium px-4 py-2 rounded-lg hover:bg-near-black/90 transition-all text-[13px] tracking-tight"
            >
              Try Caye
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section — full-bleed painted scene, text overlaid */}
      <section className="relative z-10 overflow-hidden min-h-screen flex items-start">
        {/* Background scene — fills the entire hero. Desaturated + lifted
            so it reads as atmosphere, not a finished painting competing
            with the headline for attention. */}
        <img
          src="/hero.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover z-0"
          style={{
            filter: 'saturate(0.72) brightness(1.06) contrast(0.96)',
            transform: 'scale(1.18) translateX(-7%)',
            transformOrigin: 'center',
          }}
        />

        {/* Content stack — sits over the scene in the upper-center region */}
        <div className="relative z-20 w-full pt-20 md:pt-28 px-6">
          <div className="max-w-3xl mx-auto text-center space-y-6">
            <span className="inline-flex items-center gap-2 bg-caribbean-teal/10 text-caribbean-teal-deep border border-caribbean-teal/25 px-3.5 py-1 rounded-full text-xs font-mono uppercase font-semibold tracking-wider">
              Meet Caye
            </span>

            <h1
              className="font-instrument text-5xl sm:text-6xl md:text-7xl lg:text-[5.5rem] font-normal tracking-[-0.022em] text-near-black leading-[1.02]"
              style={{ WebkitTextStroke: '0.8px currentColor' }}
            >
              Your AI{' '}
              <span className="italic text-caribbean-teal-deep">front desk</span>.
            </h1>

            <p className="text-lg md:text-xl leading-snug text-near-black/85 max-w-xl mx-auto font-medium">
              She answers, quotes, and books — across every channel you use.
            </p>

            <div className="pt-1 space-y-2.5">
              <Link
                href="/signup"
                className="relative z-30 inline-flex items-center justify-center bg-near-black text-cream font-medium px-8 py-3.5 rounded-xl hover:bg-near-black/90 transition-all text-base hover:scale-[1.01] active:scale-[0.99]"
              >
                Try Caye free
              </Link>
              <div className="text-[12.5px] text-near-black/70 font-mono tracking-tight">
                7-day free trial · $79/mo after · cancel anytime
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Feature Sections */}
      <div id="features" className="divide-y divide-near-black/5">
        
        {/* Feature A: She replies */}
        <FeatureSection
          eyebrow="She replies"
          heading="Every message, every channel —"
          accent="while you work."
          body="WhatsApp, Instagram, Messenger, email. Caye picks them up the moment they land, replies in your voice, and only flags the ones she shouldn't decide alone. She stays on the inbox. You stay on the work."
        >
          {/* HTML Mockup of Unified Inbox */}
          <div className="bg-[#FAF8F5] rounded-xl border border-near-black/10 shadow-lg overflow-hidden font-sans text-xs">
            <div className="bg-near-black/[0.03] border-b border-near-black/5 px-4 py-2.5 flex items-center justify-between">
              <div className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
              </div>
              <span className="font-mono text-[10px] tracking-widest text-near-black/40 uppercase font-semibold">Unified Inbox</span>
              <div className="w-10" />
            </div>
            
            <div className="divide-y divide-near-black/5">
              {/* Row 1 */}
              <div className="p-3.5 flex items-start justify-between bg-near-black/[0.02]">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-[#25D366] text-white flex items-center justify-center font-bold text-xs">W</div>
                  <div>
                    <div className="font-semibold text-near-black text-sm">Anna · Cruise Guest</div>
                    <div className="text-near-black/50 text-[11px]">“Hi! Do you have space for 4...”</div>
                  </div>
                </div>
                <span className="bg-[#E6F2F0] text-[#1E6157] font-mono text-[9px] font-bold px-2 py-0.5 rounded uppercase">Auto-Replied</span>
              </div>
              {/* Row 2 */}
              <div className="p-3.5 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-[#f9ce3f] via-[#e1306c] to-[#8134af] text-white flex items-center justify-center font-bold text-xs">IG</div>
                  <div>
                    <div className="font-semibold text-near-black text-sm">@thecruisemom</div>
                    <div className="text-near-black/50 text-[11px]">“What is the pricing for a group of...”</div>
                  </div>
                </div>
                <span className="bg-[#E6F2F0] text-[#1E6157] font-mono text-[9px] font-bold px-2 py-0.5 rounded uppercase">Drafted</span>
              </div>
              {/* Row 3 */}
              <div className="p-3.5 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-[#0084FF] text-white flex items-center justify-center font-bold text-xs">FB</div>
                  <div>
                    <div className="font-semibold text-near-black text-sm">David L.</div>
                    <div className="text-near-black/50 text-[11px]">“How do I book a tour for Friday?”</div>
                  </div>
                </div>
                <span className="bg-[#fce8e1] text-[#c94824] font-mono text-[9px] font-bold px-2 py-0.5 rounded uppercase">Needs Review</span>
              </div>
            </div>
          </div>
        </FeatureSection>

        {/* Feature B: She books and gets paid */}
        <FeatureSection
          eyebrow="She books"
          heading="She holds the slot —"
          accent="and takes the deposit."
          body="Caye checks your calendar, holds the time, and sends your WeTravel link. When the deposit lands, she confirms the booking and writes it to your calendar. You never touch a payment link, you never chase a reply."
          reverse
        >
          {/* Booking + payment flow mockup */}
          <div className="bg-[#FAF8F5] rounded-xl border border-near-black/10 overflow-hidden font-sans">
            <div className="bg-near-black/[0.03] border-b border-near-black/5 px-4 py-2.5 flex items-center justify-between">
              <span className="font-mono text-[10px] tracking-[0.18em] text-near-black/40 uppercase font-semibold">Anna · Saturday booking</span>
              <span className="w-2 h-2 rounded-full bg-caribbean-teal" />
            </div>

            <ol className="divide-y divide-near-black/[0.06]">
              <li className="p-4 flex items-center gap-4">
                <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-caribbean-teal-deep">01</span>
                <div className="flex-1">
                  <div className="text-[13px] font-semibold text-near-black">Slot held</div>
                  <div className="text-[11.5px] text-near-black/55">Saturday 10am · 5 people</div>
                </div>
              </li>
              <li className="p-4 flex items-center gap-4">
                <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-caribbean-teal-deep">02</span>
                <div className="flex-1">
                  <div className="text-[13px] font-semibold text-near-black">Payment link sent</div>
                  <div className="text-[11.5px] text-near-black/55 truncate">via WhatsApp · awaiting deposit</div>
                </div>
              </li>
              <li className="p-4 flex items-center gap-4 bg-caribbean-teal/[0.06]">
                <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-caribbean-teal-deep">03</span>
                <div className="flex-1">
                  <div className="text-[13px] font-semibold text-near-black flex items-center gap-2">
                    Deposit received
                    <span className="font-mono text-[10px] tabular-nums text-caribbean-teal-deep">$375</span>
                  </div>
                  <div className="text-[11.5px] text-near-black/55">Confirmation sent · added to calendar</div>
                </div>
                <span className="text-[9px] font-mono font-bold tracking-wider uppercase bg-caribbean-teal text-white px-2 py-0.5 rounded">
                  Booked
                </span>
              </li>
            </ol>

            <div className="bg-cream/60 border-t border-near-black/[0.06] px-4 py-2.5 text-[11px] font-mono tracking-tight text-near-black/55 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-caribbean-teal animate-pulse" />
              Caye closed this booking · 0 messages from you
            </div>
          </div>
        </FeatureSection>

        {/* Feature C: She follows up */}
        <FeatureSection
          eyebrow="She follows up"
          heading="She sends the thank-you —"
          accent="and brings them back."
          body="Day-before reminder. Day-after thank-you with a review ask. A quiet check-in months later when it's time to come around again. The work after the booking is what turns a one-time customer into a regular. Caye does it without you remembering to."
        >
          {/* Follow-up timeline mockup */}
          <div className="bg-[#FAF8F5] rounded-xl border border-near-black/10 overflow-hidden font-sans">
            <div className="bg-near-black/[0.03] border-b border-near-black/5 px-4 py-2.5 flex items-center justify-between">
              <span className="font-mono text-[10px] tracking-[0.18em] text-near-black/40 uppercase font-semibold">Anna · ongoing follow-up</span>
              <span className="w-2 h-2 rounded-full bg-caribbean-teal" />
            </div>

            <ul className="divide-y divide-near-black/[0.06]">
              <li className="p-4 flex items-start gap-4">
                <div className="font-mono text-[10px] font-semibold tracking-[0.18em] text-near-black/45 leading-tight pt-0.5 w-16 shrink-0 uppercase">
                  Day before
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-near-black leading-snug">
                    &ldquo;Quick reminder — see you tomorrow at 10am. Bring sunscreen and good vibes.&rdquo;
                  </p>
                  <div className="mt-1.5 text-[10px] font-mono text-near-black/45">Sent automatically</div>
                </div>
              </li>
              <li className="p-4 flex items-start gap-4">
                <div className="font-mono text-[10px] font-semibold tracking-[0.18em] text-near-black/45 leading-tight pt-0.5 w-16 shrink-0 uppercase">
                  Day after
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-near-black leading-snug">
                    &ldquo;So glad y&apos;all came by. If you have 30 seconds, would mean the world: <span className="text-caribbean-teal-deep underline">google.com/review</span>&rdquo;
                  </p>
                  <div className="mt-1.5 text-[10px] font-mono text-near-black/45">Sent automatically</div>
                </div>
              </li>
              <li className="p-4 flex items-start gap-4 bg-caribbean-teal/[0.06]">
                <div className="font-mono text-[10px] font-semibold tracking-[0.18em] text-caribbean-teal-deep leading-tight pt-0.5 w-16 shrink-0 uppercase">
                  6 mo later
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-near-black leading-snug">
                    &ldquo;Hey Anna — been a minute. Coming back this winter? Holding a few spots in December if you want first pick.&rdquo;
                  </p>
                  <div className="mt-1.5 text-[10px] font-mono text-caribbean-teal-deep font-semibold">
                    Reactivation · sent automatically
                  </div>
                </div>
              </li>
            </ul>

            <div className="bg-cream/60 border-t border-near-black/[0.06] px-4 py-2.5 text-[11px] font-mono tracking-tight text-near-black/55 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-caribbean-teal animate-pulse" />
              Caye runs the follow-up · 0 reminders to you
            </div>
          </div>
        </FeatureSection>

      </div>

      {/* How it works */}
      <section id="how" className="py-24 md:py-32 bg-near-black/[0.03] border-y border-near-black/[0.06]">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="text-center max-w-2xl mx-auto mb-20 space-y-5">
            <div className="font-mono text-[10.5px] font-semibold tracking-[0.22em] text-near-black/45 uppercase inline-flex items-center gap-2.5">
              <span className="w-1 h-1 rounded-full bg-caribbean-teal" />
              Get started in seconds
            </div>
            <h2 className="font-instrument text-[2.25rem] sm:text-[2.75rem] lg:text-[3.5rem] text-near-black tracking-[-0.018em] leading-[1.05]">
              Simple setup.{' '}
              <span className="italic text-caribbean-teal-deep">No code required.</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-near-black/[0.08] border border-near-black/[0.08] rounded-2xl overflow-hidden">
            {/* Card 1 */}
            <div className="bg-cream p-10 space-y-5">
              <div className="font-mono text-[11px] font-semibold tracking-[0.22em] uppercase text-caribbean-teal-deep">
                01 / 03
              </div>
              <h3 className="font-instrument text-2xl text-near-black leading-snug">Connect your channels</h3>
              <p className="text-near-black/65 text-[15px] leading-relaxed">
                Connect your WhatsApp Business, Instagram, Messenger, or Zoho Mail in one click.
              </p>
            </div>
            {/* Card 2 */}
            <div className="bg-cream p-10 space-y-5">
              <div className="font-mono text-[11px] font-semibold tracking-[0.22em] uppercase text-caribbean-teal-deep">
                02 / 03
              </div>
              <h3 className="font-instrument text-2xl text-near-black leading-snug">Tell Caye your details</h3>
              <p className="text-near-black/65 text-[15px] leading-relaxed">
                Services, hours, prices, and the rules she should follow — like buffer times or party limits.
              </p>
            </div>
            {/* Card 3 */}
            <div className="bg-cream p-10 space-y-5">
              <div className="font-mono text-[11px] font-semibold tracking-[0.22em] uppercase text-caribbean-teal-deep">
                03 / 03
              </div>
              <h3 className="font-instrument text-2xl text-near-black leading-snug">Go back to your tours</h3>
              <p className="text-near-black/65 text-[15px] leading-relaxed">
                Caye runs the inbox, holds the calendar, and only pings you when she really needs you.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 md:py-28 relative">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="text-center max-w-2xl mx-auto mb-14 space-y-5">
            <div className="font-mono text-[10.5px] font-semibold tracking-[0.22em] text-near-black/45 uppercase inline-flex items-center gap-2.5">
              <span className="w-1 h-1 rounded-full bg-caribbean-teal" />
              Pricing
            </div>
            <h2 className="font-instrument text-[2.25rem] sm:text-[2.75rem] lg:text-[3.5rem] text-near-black tracking-[-0.018em] leading-[1.05]">
              Flat rate.{' '}
              <span className="italic text-caribbean-teal-deep">No tiers.</span>
            </h2>
            <p className="text-near-black/65 text-base">
              Keep 100% of your booking revenue. Cancel or pause anytime.
            </p>
          </div>

          {/* Ledger — editorial price comparison */}
          <div className="max-w-2xl mx-auto mb-10">
            <div className="flex items-center gap-3 mb-3">
              <span className="font-mono text-[10px] font-semibold tracking-[0.18em] uppercase text-near-black/40">The arithmetic</span>
              <span className="flex-1 h-px bg-near-black/10" />
            </div>
            <dl className="space-y-2.5 font-sans">
              <div className="flex items-baseline gap-4">
                <dt className="flex-1 text-near-black/55 text-sm">
                  A part-time receptionist in Nassau
                </dt>
                <dd className="text-near-black/55 text-sm font-mono tabular-nums line-through decoration-near-black/40">
                  $1,800 / mo
                </dd>
              </div>
              <div className="flex items-baseline gap-4">
                <dt className="flex-1 text-near-black text-sm font-medium">
                  Caye · always on, every channel
                </dt>
                <dd className="text-caribbean-teal-deep text-sm font-mono tabular-nums font-semibold">
                  $79 / mo
                </dd>
              </div>
            </dl>
            <div className="flex items-center gap-3 mt-3">
              <span className="flex-1 h-px bg-near-black/10" />
              <span className="text-near-black/55 text-[12.5px] italic font-serif tracking-tight">
                One missed booking pays for a year.
              </span>
              <span className="flex-1 h-px bg-near-black/10" />
            </div>
          </div>

          {/* Billing cadence toggle */}
          <div className="flex justify-center mb-10">
            <div
              role="tablist"
              aria-label="Billing cadence"
              className="inline-flex items-center bg-near-black/[0.04] border border-near-black/10 rounded-full p-1"
            >
              <button
                role="tab"
                aria-selected={billing === 'monthly'}
                onClick={() => setBilling('monthly')}
                className={`relative px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-all ${
                  billing === 'monthly'
                    ? 'bg-white text-near-black shadow-sm'
                    : 'text-near-black/55 hover:text-near-black/80'
                }`}
              >
                Monthly
              </button>
              <button
                role="tab"
                aria-selected={billing === 'annual'}
                onClick={() => setBilling('annual')}
                className={`relative px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-all flex items-center gap-2 ${
                  billing === 'annual'
                    ? 'bg-white text-near-black shadow-sm'
                    : 'text-near-black/55 hover:text-near-black/80'
                }`}
              >
                Annual
                <span className={`font-mono text-[9px] tracking-wider uppercase px-1.5 py-0.5 rounded ${
                  billing === 'annual' ? 'bg-caribbean-teal/15 text-caribbean-teal-deep' : 'bg-near-black/[0.08] text-near-black/45'
                }`}>
                  2 mo free
                </span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            {/* Card 1 — Caye */}
            <div className="bg-white rounded-3xl p-8 md:p-10 border border-near-black/10 shadow-md flex flex-col justify-between hover:scale-[1.005] transition-transform">
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-2xl font-semibold">Caye</h3>
                  <p className="text-near-black/60 text-sm">Full AI receptionist for solo operators.</p>
                </div>

                <div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-5xl font-bold tracking-tight tabular-nums">{pricing.caye[billing].display}</span>
                    <span className="text-near-black/50 font-mono text-xs uppercase font-semibold">{pricing.caye[billing].cadence}</span>
                  </div>
                  <p className={`mt-2 text-[11.5px] text-near-black/55 transition-opacity ${pricing.caye[billing].footnote ? 'opacity-100' : 'opacity-0 h-0'}`}>
                    {pricing.caye[billing].footnote ?? ' '}
                  </p>
                </div>

                <ul className="space-y-3.5 border-t border-near-black/5 pt-6 text-sm text-near-black/80">
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Replies on WhatsApp, Instagram, Messenger, and email — 24/7
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Quotes prices automatically from your services
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Sends your WeTravel (or other) payment links
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Books into your calendar — Zoho-synced
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Pings you for the ones she shouldn't decide
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    No setup fees, no contracts
                  </li>
                </ul>
              </div>

              <Link href="/signup" className="mt-8 inline-flex items-center justify-center bg-near-black text-cream px-6 py-3 rounded-xl hover:bg-near-black/90 transition-colors font-medium text-sm">
                Start 7-day trial
              </Link>
            </div>

            {/* Card 2 — Caye + Website */}
            <div className="bg-white rounded-3xl p-8 md:p-10 border border-caribbean-teal/30 shadow-lg flex flex-col justify-between relative ring-1 ring-caribbean-teal/15 hover:scale-[1.005] transition-transform">
              <div className="absolute top-5 right-5 bg-caribbean-teal text-white font-mono text-[9px] font-bold tracking-wider uppercase px-2.5 py-1 rounded-full shadow-sm">
                Most operators pick this
              </div>

              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-2xl font-semibold">Caye + Website</h3>
                  <p className="text-near-black/60 text-sm">Full reception plus a website for your business.</p>
                </div>

                <div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-5xl font-bold tracking-tight tabular-nums">{pricing.bundle[billing].display}</span>
                    <span className="text-near-black/50 font-mono text-xs uppercase font-semibold">{pricing.bundle[billing].cadence}</span>
                  </div>
                  <p className={`mt-2 text-[11.5px] text-near-black/55 transition-opacity ${pricing.bundle[billing].footnote ? 'opacity-100' : 'opacity-0 h-0'}`}>
                    {pricing.bundle[billing].footnote ?? ' '}
                  </p>
                </div>

                <ul className="space-y-3.5 border-t border-near-black/5 pt-6 text-sm text-near-black/80">
                  <li className="flex items-center gap-2.5 font-semibold text-caribbean-teal-deep">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Everything in Caye
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    A custom website built for your business
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Domain, hosting, and SSL — handled
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Ongoing updates and maintenance
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Site changes by message — no tickets
                  </li>
                </ul>
              </div>

              <Link href="/signup" className="mt-8 inline-flex items-center justify-center bg-caribbean-teal text-white px-6 py-3 rounded-xl hover:bg-caribbean-teal-hover transition-colors font-medium text-sm shadow-sm">
                Start 7-day trial
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Accordion */}
      <section className="py-24 md:py-32 bg-near-black/[0.02] border-t border-near-black/[0.06]">
        <div className="max-w-3xl mx-auto px-6">
          <div className="text-center mb-14 space-y-5">
            <div className="font-mono text-[10.5px] font-semibold tracking-[0.22em] text-near-black/45 uppercase inline-flex items-center gap-2.5">
              <span className="w-1 h-1 rounded-full bg-caribbean-teal" />
              Questions
            </div>
            <h2 className="font-instrument text-[2.25rem] sm:text-[2.75rem] lg:text-[3.25rem] text-near-black tracking-[-0.018em] leading-[1.05]">
              Things people{' '}
              <span className="italic text-caribbean-teal-deep">ask first.</span>
            </h2>
          </div>

          <div className="divide-y divide-near-black/[0.08] border-t border-b border-near-black/[0.08]">
            {/* FAQ 1 */}
            <div className="py-5">
              <button 
                onClick={() => toggleFaq(0)} 
                className="w-full flex items-center justify-between text-left font-medium text-base md:text-lg text-near-black focus:outline-none"
              >
                <span>What channels does Caye support?</span>
                <span className="text-lg opacity-60">{activeFaq === 0 ? '−' : '+'}</span>
              </button>
              {activeFaq === 0 && (
                <p className="mt-3 text-sm md:text-base text-near-black/70 leading-relaxed font-sans">
                  Caye supports WhatsApp Business, Instagram Direct Messages, Facebook Messenger, and Zoho Mail.
                </p>
              )}
            </div>

            {/* FAQ 2 */}
            <div className="py-5">
              <button 
                onClick={() => toggleFaq(1)} 
                className="w-full flex items-center justify-between text-left font-medium text-base md:text-lg text-near-black focus:outline-none"
              >
                <span>Do I need to be technical?</span>
                <span className="text-lg opacity-60">{activeFaq === 1 ? '−' : '+'}</span>
              </button>
              {activeFaq === 1 && (
                <p className="mt-3 text-sm md:text-base text-near-black/70 leading-relaxed font-sans">
                  Not at all. Connecting your accounts is as simple as logging into Facebook and Google. I'll jump on a call to walk you through setup — I'm based in Nassau.
                </p>
              )}
            </div>

            {/* FAQ 3 */}
            <div className="py-5">
              <button 
                onClick={() => toggleFaq(2)} 
                className="w-full flex items-center justify-between text-left font-medium text-base md:text-lg text-near-black focus:outline-none"
              >
                <span>What if Caye gets something wrong?</span>
                <span className="text-lg opacity-60">{activeFaq === 2 ? '−' : '+'}</span>
              </button>
              {activeFaq === 2 && (
                <p className="mt-3 text-sm md:text-base text-near-black/70 leading-relaxed font-sans">
                  Caye will never lie or guess. If she is unsure of an availability detail or does not understand a custom request, she will hold the message and flag it in your dashboard, notifying you to step in.
                </p>
              )}
            </div>

            {/* FAQ 4 */}
            <div className="py-5">
              <button 
                onClick={() => toggleFaq(3)} 
                className="w-full flex items-center justify-between text-left font-medium text-base md:text-lg text-near-black focus:outline-none"
              >
                <span>Can I cancel anytime?</span>
                <span className="text-lg opacity-60">{activeFaq === 3 ? '−' : '+'}</span>
              </button>
              {activeFaq === 3 && (
                <p className="mt-3 text-sm md:text-base text-near-black/70 leading-relaxed font-sans">
                  Yes. We offer a flat monthly subscription with no contracts. You can pause or cancel your subscription at any time directly in your account settings.
                </p>
              )}
            </div>

            {/* FAQ 5 */}
            <div className="py-5">
              <button 
                onClick={() => toggleFaq(4)} 
                className="w-full flex items-center justify-between text-left font-medium text-base md:text-lg text-near-black focus:outline-none"
              >
                <span>What languages does she handle?</span>
                <span className="text-lg opacity-60">{activeFaq === 4 ? '−' : '+'}</span>
              </button>
              {activeFaq === 4 && (
                <p className="mt-3 text-sm md:text-base text-near-black/70 leading-relaxed font-sans">
                  English today. Spanish, French, and Creole are on the roadmap — let me know which one matters most to your guests.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-near-black/5 bg-near-black/5 py-12 md:py-16 text-sm relative z-10 font-sans">
        <div className="max-w-7xl mx-auto px-6 md:px-12 flex flex-col md:flex-row justify-between items-start gap-8">
          <div className="space-y-3">
            <Link href="/" className="flex items-center select-none">
              <CayeLogo size={28} />
            </Link>
            <p className="text-near-black/60 max-w-[280px]">
              Built by TropiTech in Nassau, Bahamas. Supporting Caribbean business owners.
            </p>
          </div>
          
          <div className="flex flex-wrap gap-x-16 gap-y-8 text-near-black/75">
            <div className="space-y-3">
              <h4 className="font-mono text-xs font-bold text-near-black/40 uppercase tracking-widest">Product</h4>
              <ul className="space-y-2">
                <li><Link href="/signup" className="hover:text-near-black">Get Started</Link></li>
                <li><a href="#how" className="hover:text-near-black">How it works</a></li>
                <li><a href="#pricing" className="hover:text-near-black">Pricing</a></li>
              </ul>
            </div>
            <div className="space-y-3">
              <h4 className="font-mono text-xs font-bold text-near-black/40 uppercase tracking-widest">Legal</h4>
              <ul className="space-y-2">
                <li><Link href="/privacy" className="hover:text-near-black">Privacy Policy</Link></li>
                <li><Link href="/terms" className="hover:text-near-black">Terms of Service</Link></li>
                <li><a href="mailto:lamar@tropitech.org" className="hover:text-near-black">Contact</a></li>
              </ul>
            </div>
          </div>
        </div>
        
        <div className="max-w-7xl mx-auto px-6 md:px-12 mt-12 pt-6 border-t border-near-black/5 flex flex-col md:flex-row justify-between text-near-black/40 text-xs">
          <span>© 2026 Caye by TropiTech. Built in Nassau, Bahamas.</span>
          <span>Nassau · Bahamas</span>
        </div>
      </footer>
    </div>
  )
}
