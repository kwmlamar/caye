'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import WhatsAppMockup from '@/components/landing/WhatsAppMockup'
import FeatureSection from '@/components/landing/FeatureSection'
import { CayeLogo } from '@/components/brand/CayeLogo'
import { CayeMark } from '@/components/brand/CayeMark'

export default function LandingPage() {
  const [activeFaq, setActiveFaq] = useState<number | null>(null)

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

      {/* Navigation */}
      <header className="sticky top-0 z-50 bg-cream/80 backdrop-blur-md border-b border-near-black/5">
        <div className="max-w-7xl mx-auto px-6 md:px-12 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center select-none">
            <CayeLogo size={36} />
          </Link>

          <nav className="hidden md:flex items-center gap-8">
            <a href="#how" className="text-sm font-medium text-near-black/75 hover:text-near-black transition-colors">How it works</a>
            <a href="#features" className="text-sm font-medium text-near-black/75 hover:text-near-black transition-colors">For operators</a>
            <a href="#pricing" className="text-sm font-medium text-near-black/75 hover:text-near-black transition-colors">Pricing</a>
          </nav>

          <div className="flex items-center gap-4">
            <Link href="/login" className="text-sm font-medium text-near-black/75 hover:text-near-black transition-colors">Log in</Link>
            <Link href="/signup" className="text-sm font-medium bg-caribbean-teal text-white px-4 py-2 rounded-lg hover:bg-caribbean-teal-hover transition-all shadow-sm hover:scale-[1.01] active:scale-[0.99]">
              Try Caye
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative z-10 pt-16 pb-20 md:py-28 lg:py-36">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-12 items-center">
            
            {/* Copy */}
            <div className="space-y-8 max-w-xl">
              <span className="inline-flex items-center gap-2 bg-caribbean-teal/10 text-caribbean-teal border border-caribbean-teal/20 px-3.5 py-1 rounded-full text-xs font-mono uppercase font-semibold">
                Built for Caribbean operators
              </span>
              
              <h1 className="text-4xl sm:text-5xl md:text-6xl font-semibold tracking-tight text-near-black leading-[1.05]">
                Your receptionist for <span className="font-serif italic text-caribbean-teal font-normal">taking bookings</span>.
              </h1>
              
              <p className="text-lg md:text-[19px] leading-relaxed text-near-black/75">
                Caye answers WhatsApp, Instagram, Messenger, and email — confirms the bookings, flags what needs your call, and keeps you out of the inbox.
              </p>
              
              <div className="space-y-4">
                <Link href="/signup" className="inline-flex items-center justify-center bg-caribbean-teal text-white font-medium px-8 py-3.5 rounded-xl hover:bg-caribbean-teal-hover transition-all text-base shadow-sm hover:scale-[1.01] active:scale-[0.99] w-full sm:w-auto">
                  Try Caye
                </Link>
                <div className="text-[13px] text-near-black/50 font-mono tracking-tight">
                  7-day free trial · $79/mo after · cancel anytime
                </div>
              </div>
            </div>

            {/* Product Mockup */}
            <div className="relative">
              <div className="absolute -inset-1 rounded-3xl bg-near-black/5 blur-lg pointer-events-none" />
              <WhatsAppMockup />
            </div>

          </div>
        </div>
      </section>

      {/* Social Proof Strip */}
      <section className="border-t border-b border-near-black/5 py-8 bg-near-black/[0.01]">
        <div className="max-w-7xl mx-auto px-6 md:px-12 text-center text-sm md:text-base font-mono tracking-tight text-near-black/60">
          Running live for <span className="text-near-black font-semibold">Bimini Island Tours</span> and <span className="text-near-black font-semibold">Simply Dave Tours</span>.
        </div>
      </section>

      {/* Feature Sections */}
      <div id="features" className="divide-y divide-near-black/5">
        
        {/* Feature A: Unified Inbox */}
        <FeatureSection
          eyebrow="One inbox"
          heading="WhatsApp, Instagram, Messenger, email — one screen."
          body="Every guest message in one place. Caye sorts what needs you from what she already handled, giving you a clean queue that actually stays quiet."
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

        {/* Feature B: Auto-Confirmed Bookings */}
        <FeatureSection
          eyebrow="Bookings"
          heading="She checks your calendar before she replies."
          body="Caye reads incoming requests, checks your Zoho Calendar for conflicts, and only confirms what actually fits. No double-booked tours, no manual validation needed."
          reverse
        >
          {/* HTML Mockup of Calendar Integration */}
          <div className="bg-[#FAF8F5] rounded-xl border border-near-black/10 shadow-lg overflow-hidden font-sans text-xs">
            <div className="bg-near-black/[0.03] border-b border-near-black/5 px-4 py-2.5 flex items-center justify-between">
              <span className="font-mono text-[10px] tracking-widest text-near-black/40 uppercase font-semibold">Zoho Calendar Sync</span>
              <div className="w-4 h-4 rounded-full bg-caribbean-teal" />
            </div>
            
            <div className="p-4 grid grid-cols-3 gap-3">
              <div className="space-y-2 border-r border-near-black/5 pr-2">
                <div className="font-mono text-[10px] uppercase text-near-black/40 font-bold">Wed 27</div>
                <div className="bg-near-black/5 p-2 rounded text-[11px] font-medium">10am snorkel tour<br/><span className="text-near-black/50">2 slots open</span></div>
              </div>
              <div className="space-y-2 border-r border-near-black/5 pr-2">
                <div className="font-mono text-[10px] uppercase text-caribbean-teal font-bold">Thu 28</div>
                <div className="bg-caribbean-teal/10 border border-caribbean-teal/20 p-2 rounded text-[11px] font-medium text-caribbean-teal-deep">
                  <div className="font-semibold">Snorkel + Lunch</div>
                  <span className="text-[10px] opacity-75">10:00 AM · 4 guests</span>
                  <div className="text-[9px] bg-caribbean-teal text-white px-1 py-0.5 rounded w-max mt-1 font-mono uppercase">Confirmed</div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase text-near-black/40 font-bold">Fri 29</div>
                <div className="bg-near-black/5 p-2 rounded text-[11px] font-medium">Closed<br/><span className="text-near-black/50">Day off</span></div>
              </div>
            </div>

            <div className="bg-caribbean-teal/5 border-t border-caribbean-teal/10 p-3 flex items-center justify-between">
              <span className="text-[11px] text-near-black/70 font-mono">Status: Calendar updated in 0.4s</span>
              <span className="w-2.5 h-2.5 rounded-full bg-caribbean-teal animate-ping" />
            </div>
          </div>
        </FeatureSection>

        {/* Feature C: She learns your voice */}
        <FeatureSection
          eyebrow="Sounds like you"
          heading="Caye picks up how you talk."
          body="Every reply you send teaches her. After a few days she sounds like you, not like a generic chatbot. She mirrors your warmth, details, and exact instructions."
        >
          {/* Side-by-side Voice Mockup */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Generic AI Card */}
            <div className="bg-white rounded-xl border border-near-black/10 p-4 space-y-3 relative overflow-hidden">
              <span className="absolute top-0 right-0 bg-near-black/10 text-near-black/70 px-2 py-0.5 font-mono text-[9px] uppercase font-bold rounded-bl">Generic AI</span>
              <div className="w-8 h-8 rounded-lg bg-near-black/5 text-near-black/50 flex items-center justify-center font-mono text-[10px] font-bold tracking-wider uppercase">AI</div>
              <div className="font-semibold text-xs text-near-black/40 uppercase tracking-widest font-mono">Cold reply</div>
              <p className="text-[12.5px] leading-relaxed text-near-black/60 font-sans italic">
                “Dear customer, thank you for your query. Regarding your booking request for the snorkeling excursion, we are pleased to inform you that we have available slots. Please respond to confirm.”
              </p>
            </div>
            
            {/* Caye Card */}
            <div className="bg-white rounded-xl border border-caribbean-teal/30 p-4 space-y-3 relative overflow-hidden ring-1 ring-caribbean-teal/15 shadow-md">
              <span className="absolute top-0 right-0 bg-caribbean-teal text-white px-2 py-0.5 font-mono text-[9px] uppercase font-bold rounded-bl">Caye Receptionist</span>
              <div className="w-8 h-8 rounded-lg bg-caribbean-teal/10 flex items-center justify-center">
                <CayeMark size={16} variant="primary" />
              </div>
              <div className="font-semibold text-xs text-caribbean-teal uppercase tracking-widest font-mono">Karenda&apos;s Voice</div>
              <p className="text-[12.5px] leading-relaxed text-near-black font-sans font-medium">
                “Hey there! Yes, we have space for 4 on Thursday morning. The boat leaves the pier at 10am sharp. Bring sunscreen, lunch is on us! Let me know if you want me to lock it in. — Karenda”
              </p>
            </div>
          </div>
        </FeatureSection>

      </div>

      {/* How it works */}
      <section id="how" className="py-20 md:py-28 bg-near-black/5 border-t border-b border-near-black/5">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="text-center max-w-xl mx-auto mb-16 space-y-4">
            <span className="font-mono text-xs font-semibold tracking-widest text-near-black/50 uppercase">Get started in seconds</span>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-near-black">
              Simple setup. No code required.
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Card 1 */}
            <div className="bg-cream rounded-2xl p-8 border border-near-black/10 shadow-sm space-y-4 hover:scale-[1.01] transition-transform">
              <div className="w-10 h-10 rounded-full bg-caribbean-teal text-white flex items-center justify-center font-mono font-bold">1</div>
              <h3 className="text-xl font-semibold">Connect your channels</h3>
              <p className="text-near-black/70 text-sm leading-relaxed">
                Connect your WhatsApp Business, Instagram, Messenger, or Zoho Mail in just one click.
              </p>
            </div>
            {/* Card 2 */}
            <div className="bg-cream rounded-2xl p-8 border border-near-black/10 shadow-sm space-y-4 hover:scale-[1.01] transition-transform">
              <div className="w-10 h-10 rounded-full bg-caribbean-teal text-white flex items-center justify-center font-mono font-bold">2</div>
              <h3 className="text-xl font-semibold">Tell Caye your details</h3>
              <p className="text-near-black/70 text-sm leading-relaxed">
                Provide services, hours, pricing, and specific rules (like buffer times or tour capacities).
              </p>
            </div>
            {/* Card 3 */}
            <div className="bg-cream rounded-2xl p-8 border border-near-black/10 shadow-sm space-y-4 hover:scale-[1.01] transition-transform">
              <div className="w-10 h-10 rounded-full bg-caribbean-teal text-white flex items-center justify-center font-mono font-bold">3</div>
              <h3 className="text-xl font-semibold">Go back to your tours</h3>
              <p className="text-near-black/70 text-sm leading-relaxed">
                Caye handles the messages, updates the calendar, and only interrupts you if a lead needs your review.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 md:py-28 relative">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="text-center max-w-xl mx-auto mb-16 space-y-4">
            <span className="font-mono text-xs font-semibold tracking-widest text-near-black/50 uppercase">Pricing</span>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-near-black">
              Flat rate pricing. No tiers.
            </h2>
            <p className="text-near-black/60 text-sm">
              Keep 100% of your booking revenues. Cancel or pause anytime.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            {/* Card 1 */}
            <div className="bg-white rounded-3xl p-8 md:p-10 border border-near-black/10 shadow-md flex flex-col justify-between hover:scale-[1.005] transition-transform">
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-2xl font-semibold">Caye</h3>
                  <p className="text-near-black/60 text-sm">Full AI receptionist for solo operators.</p>
                </div>
                
                <div className="flex items-baseline gap-1">
                  <span className="text-5xl font-bold tracking-tight">$79</span>
                  <span className="text-near-black/50 font-mono text-xs uppercase font-semibold">/ month</span>
                </div>

                <ul className="space-y-3.5 border-t border-near-black/5 pt-6 text-sm text-near-black/75">
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    WhatsApp, Instagram, Messenger, and Zoho Mail
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Auto-confirmed bookings & Zoho Calendar sync
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Customer history & profiles
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Unlimited messages
                  </li>
                </ul>
              </div>

              <Link href="/signup" className="mt-8 inline-flex items-center justify-center bg-near-black text-cream px-6 py-3 rounded-xl hover:bg-near-black/90 transition-colors font-medium text-sm">
                Start 7-day trial
              </Link>
            </div>

            {/* Card 2 */}
            <div className="bg-white rounded-3xl p-8 md:p-10 border border-caribbean-teal/30 shadow-lg flex flex-col justify-between relative ring-1 ring-caribbean-teal/15 hover:scale-[1.005] transition-transform">
              <div className="absolute top-5 right-5 bg-caribbean-teal text-white font-mono text-[9px] font-bold tracking-wider uppercase px-2.5 py-1 rounded-full shadow-sm">
                Most operators pick this
              </div>
              
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-2xl font-semibold">Caye + Website</h3>
                  <p className="text-near-black/60 text-sm">Full reception plus a website for your business.</p>
                </div>
                
                <div className="flex items-baseline gap-1">
                  <span className="text-5xl font-bold tracking-tight">$129</span>
                  <span className="text-near-black/50 font-mono text-xs uppercase font-semibold">/ month</span>
                </div>

                <ul className="space-y-3.5 border-t border-near-black/5 pt-6 text-sm text-near-black/75">
                  <li className="flex items-center gap-2.5 font-semibold text-caribbean-teal-deep">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Everything included in Caye
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    TropiTech-built custom business website
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Domain name, hosting, and SSL included
                  </li>
                  <li className="flex items-center gap-2.5">
                    <span className="text-caribbean-teal text-lg">✓</span>
                    Ongoing updates & full maintenance
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
      <section className="py-20 bg-near-black/[0.01] border-t border-near-black/5">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-center text-near-black mb-12">
            Frequently Asked Questions
          </h2>

          <div className="divide-y divide-near-black/10 border-t border-b border-near-black/10">
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
