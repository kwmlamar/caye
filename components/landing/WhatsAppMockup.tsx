'use client'

// Interactive WhatsApp demo. Replaces the dashboard mockup as the
// landing's product proof: per the locked positioning, WhatsApp is
// Caye's daily operator surface.
//
// Design intent: turn the phone from "screenshot-on-cream" into a
// tactile artifact — a phone sitting in soft Caribbean light, not
// pasted on a background. Refined hardware, doodle wallpaper, ground
// shadow, multi-layer atmospheric glow, staggered scroll reveal.

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Message {
  id: string
  from: 'caye' | 'user'
  text: string
  time: string
}

interface ConvOption {
  prompt: string
  reply: string
}

const CONVERSATIONS: ConvOption[] = [
  {
    prompt: 'What did you do this morning?',
    reply:
      "Replied to two booking inquiries — Maya and James, both confirmed for Saturday. Held one from Daniel; he's asking about a custom charter on your day off.",
  },
  {
    prompt: 'Send Daniel a quote',
    reply:
      "Done. Sent him our standard charter rate and asked for his preferred date. I'll let you know when he replies.",
  },
  {
    prompt: "What's on the calendar today?",
    reply:
      '3 confirmed tours — Maya at 9 AM, James’s group at 1 PM, and a held slot at 4 PM waiting on deposit.',
  },
]

const INITIAL_MESSAGES: Message[] = [
  {
    id: 'i1',
    from: 'caye',
    text: "Hey — I'm Caye. I'll handle your DMs and bookings in your voice.",
    time: '7:42 AM',
  },
  {
    id: 'i2',
    from: 'caye',
    text: "Tap one below and I'll show you what I do.",
    time: '7:42 AM',
  },
]

function nowTime(): string {
  const d = new Date()
  return d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export default function WhatsAppMockup() {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES)
  const [usedPrompts, setUsedPrompts] = useState<Set<string>>(new Set())
  const [typing, setTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typing])

  async function handleTap(option: ConvOption) {
    if (typing) return
    setUsedPrompts((prev) => new Set([...prev, option.prompt]))
    const userId = `u-${Date.now()}`
    setMessages((prev) => [
      ...prev,
      { id: userId, from: 'user', text: option.prompt, time: nowTime() },
    ])
    setTyping(true)
    await new Promise((r) => setTimeout(r, 1200))
    setTyping(false)
    setMessages((prev) => [
      ...prev,
      {
        id: `c-${Date.now()}`,
        from: 'caye',
        text: option.reply,
        time: nowTime(),
      },
    ])
  }

  const availableOptions = CONVERSATIONS.filter(
    (c) => !usedPrompts.has(c.prompt)
  )
  const allDone = availableOptions.length === 0
  const firstTapNotYet = usedPrompts.size === 0

  return (
    <section className="relative bg-cream py-28 md:py-36 px-6 overflow-hidden">
      {/* ── Atmospheric layers ───────────────────────────────────── */}
      {/* Deep teal pool behind the phone */}
      <div
        aria-hidden
        className="absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 w-[640px] h-[640px] rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, rgba(0,119,139,0.10) 0%, rgba(0,119,139,0.04) 45%, transparent 70%)',
          filter: 'blur(40px)',
        }}
      />
      {/* Warm gold sunlight from upper right */}
      <div
        aria-hidden
        className="absolute right-[12%] top-[18%] w-[420px] h-[420px] rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, rgba(255,214,143,0.18) 0%, rgba(255,214,143,0.06) 50%, transparent 75%)',
          filter: 'blur(60px)',
        }}
      />
      {/* Soft mint glow from lower left */}
      <div
        aria-hidden
        className="absolute left-[10%] bottom-[20%] w-[360px] h-[360px] rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, rgba(168,220,192,0.20) 0%, rgba(168,220,192,0.06) 50%, transparent 75%)',
          filter: 'blur(50px)',
        }}
      />
      {/* Note: removed the mix-blend-overlay grain texture — even at 4%
          opacity it softened text rendering noticeably across the phone
          screen. The radial glows do enough atmospheric work on their
          own. */}

      <div className="relative max-w-6xl mx-auto">
        {/* ── Editorial caption ─────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-120px' }}
          transition={{ duration: 0.7, ease: [0.25, 0.1, 0.25, 1] }}
          className="text-center mb-16 md:mb-20"
        >
          <div className="flex items-center justify-center gap-3 mb-6">
            <span className="h-px w-8 bg-near-black/25" />
            <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/60 font-medium">
              Tap to try
            </span>
            <span className="h-px w-8 bg-near-black/25" />
          </div>
          <h2 className="font-instrument text-4xl md:text-5xl lg:text-6xl tracking-[-0.024em] text-near-black leading-[1.02]">
            Just text her.{' '}
            <span className="italic text-caribbean-teal-deep">She handles it</span>.
          </h2>
          <p className="mt-6 font-newsreader font-light text-[1.15rem] md:text-[1.25rem] text-near-black/70 max-w-md mx-auto leading-snug">
            Set up the dashboard once. After that, Caye lives in WhatsApp &mdash; talk to her like an employee.
          </p>
        </motion.div>

        {/* ── Phone stage ──────────────────────────────────────── */}
        <div className="relative mx-auto" style={{ width: 'fit-content' }}>
          {/* Decorative ornaments flanking the phone */}
          <DecorativeOrnaments />

          {/* Ground shadow */}
          <div
            aria-hidden
            className="absolute left-1/2 -translate-x-1/2 bottom-[-32px] w-[300px] h-[40px] pointer-events-none"
            style={{
              background:
                'radial-gradient(ellipse, rgba(14,26,26,0.22) 0%, rgba(14,26,26,0.10) 40%, transparent 70%)',
              filter: 'blur(8px)',
            }}
          />

          {/* Phone with gentle float */}
          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.97 }}
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.85, ease: [0.25, 0.1, 0.25, 1], delay: 0.1 }}
            className="relative"
          >
            <div className="animate-[phone-float_7s_ease-in-out_infinite]">
              <PhoneFrame>
                {/* Status bar */}
                <div className="relative px-7 pt-3 pb-1 flex items-center justify-between text-white z-10">
                  <span className="font-semibold text-[14px] tracking-tight">9:41</span>
                  <div className="flex items-center gap-1.5">
                    <SignalIcon />
                    <WifiIcon />
                    <BatteryIcon />
                  </div>
                </div>

                {/* WhatsApp header */}
                <div
                  className="relative px-3 pt-2 pb-3 flex items-center gap-3 z-10"
                  style={{
                    background:
                      'linear-gradient(180deg, #075E54 0%, #064f47 100%)',
                    boxShadow: '0 1px 0 rgba(0,0,0,0.15)',
                  }}
                >
                  <ChevronLeftIcon />
                  <div className="relative">
                    <CayeAvatar size={38} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-[14.5px] font-medium leading-tight">
                      Caye
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {!typing && (
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-[#7EE787] opacity-70 animate-ping" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#7EE787]" />
                        </span>
                      )}
                      <span className="text-white/75 text-[11px] leading-tight italic">
                        {typing ? 'typing…' : 'online'}
                      </span>
                    </div>
                  </div>
                  <VideoIcon />
                  <PhoneIcon />
                  <MoreIcon />
                </div>

                {/* Messages — over WhatsApp doodle wallpaper */}
                <div className="relative flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
                  <DoodleWallpaper />
                  <div className="relative z-10 space-y-1.5">
                    <DateChip>Today</DateChip>
                    <AnimatePresence initial={false}>
                      {messages.map((m) => (
                        <motion.div
                          key={m.id}
                          initial={{ opacity: 0, y: 6, scale: 0.96 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          transition={{
                            duration: 0.32,
                            ease: [0.25, 0.1, 0.25, 1],
                          }}
                        >
                          <MessageBubble message={m} />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    {typing && (
                      <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <TypingBubble />
                      </motion.div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                </div>

                {/* Suggestion bar or CTA */}
                <div className="relative z-10">
                  {!allDone ? (
                    <div
                      className="border-t border-near-black/10 px-3 py-3 space-y-2"
                      style={{
                        background:
                          'linear-gradient(180deg, #F6F2EC 0%, #EEE7DD 100%)',
                      }}
                    >
                      <div className="text-center font-mono text-[9px] uppercase tracking-[0.18em] text-near-black/40 mb-2">
                        Tap a message
                      </div>
                      {availableOptions.map((opt, idx) => (
                        <motion.button
                          key={opt.prompt}
                          onClick={() => handleTap(opt)}
                          disabled={typing}
                          initial={{ opacity: 0, x: 12 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{
                            duration: 0.28,
                            ease: [0.25, 0.1, 0.25, 1],
                            delay: idx * 0.06,
                          }}
                          whileHover={{ y: -1, scale: 1.005 }}
                          whileTap={{ scale: 0.98 }}
                          className={`block w-full text-left text-near-black text-[13px] px-3.5 py-2.5 rounded-2xl rounded-br-md disabled:opacity-50 disabled:cursor-not-allowed transition-shadow ${
                            firstTapNotYet && idx === 0
                              ? 'animate-[bubble-invite_2.4s_ease-in-out_infinite]'
                              : ''
                          }`}
                          style={{
                            background:
                              'linear-gradient(180deg, #E2FAC9 0%, #D2EFB1 100%)',
                            boxShadow:
                              '0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(14,26,26,0.10), 0 4px 12px -4px rgba(14,26,26,0.08)',
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span>{opt.prompt}</span>
                            <SendIcon />
                          </div>
                        </motion.button>
                      ))}
                    </div>
                  ) : (
                    <motion.a
                      href="/signup"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.4 }}
                      className="block text-white text-center py-4 px-4 font-medium text-[14px] transition-colors flex items-center justify-center gap-2"
                      style={{
                        background:
                          'linear-gradient(180deg, #0a8475 0%, #075E54 100%)',
                      }}
                    >
                      Try Caye yourself
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path
                          d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </motion.a>
                  )}
                </div>
              </PhoneFrame>
            </div>
          </motion.div>
        </div>

        {/* ── Sub-caption ──────────────────────────────────────── */}
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mt-14 text-center font-newsreader italic text-[15px] text-near-black/60 max-w-lg mx-auto leading-relaxed"
        >
          No workflows to build. No automations to wire. You message Caye like a
          coworker, and she figures the rest out.
        </motion.p>
      </div>
    </section>
  )
}

// ─── Phone frame ─────────────────────────────────────────────────────

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative" style={{ width: 380 }}>
      {/* Side buttons (right) */}
      <div
        aria-hidden
        className="absolute -right-[3px] top-[110px] w-[3px] h-[60px] rounded-r"
        style={{
          background:
            'linear-gradient(90deg, #2a2a2a 0%, #1a1a1a 50%, #0a0a0a 100%)',
        }}
      />
      {/* Side buttons (left — volume up/down + silent) */}
      <div
        aria-hidden
        className="absolute -left-[3px] top-[90px] w-[3px] h-[28px] rounded-l"
        style={{
          background:
            'linear-gradient(-90deg, #2a2a2a 0%, #1a1a1a 50%, #0a0a0a 100%)',
        }}
      />
      <div
        aria-hidden
        className="absolute -left-[3px] top-[135px] w-[3px] h-[52px] rounded-l"
        style={{
          background:
            'linear-gradient(-90deg, #2a2a2a 0%, #1a1a1a 50%, #0a0a0a 100%)',
        }}
      />
      <div
        aria-hidden
        className="absolute -left-[3px] top-[195px] w-[3px] h-[52px] rounded-l"
        style={{
          background:
            'linear-gradient(-90deg, #2a2a2a 0%, #1a1a1a 50%, #0a0a0a 100%)',
        }}
      />

      {/* Outer bezel */}
      <div
        className="rounded-[46px] p-[10px] relative"
        style={{
          background:
            'linear-gradient(155deg, #1f1f1f 0%, #0c0c0c 45%, #1a1a1a 100%)',
          boxShadow:
            '0 36px 90px -28px rgba(14,26,26,0.55), 0 12px 40px -16px rgba(14,26,26,0.35), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(255,255,255,0.04)',
        }}
      >
        {/* Top highlight reflection */}
        <div
          aria-hidden
          className="absolute inset-x-12 top-0 h-[2px] rounded-full opacity-50"
          style={{
            background:
              'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 50%, transparent 100%)',
          }}
        />

        {/* Screen */}
        <div
          className="relative rounded-[36px] overflow-hidden h-[680px] flex flex-col"
          style={{ background: '#ECE5DD' }}
        >
          {/* Dynamic Island */}
          <div
            aria-hidden
            className="absolute left-1/2 -translate-x-1/2 top-2 w-[100px] h-[28px] rounded-full bg-black z-30"
            style={{ boxShadow: '0 0 0 1px rgba(255,255,255,0.04)' }}
          />
          {children}
        </div>
      </div>
    </div>
  )
}

// ─── Decorative ornaments (small editorial flourishes) ──────────────

function DecorativeOrnaments() {
  return (
    <>
      {/* Wave glyph upper-left */}
      <svg
        aria-hidden
        className="absolute hidden lg:block -left-24 top-12 w-16 h-16 text-caribbean-teal-deep/25"
        viewBox="0 0 64 64"
        fill="none"
      >
        <path
          d="M4 32 Q 14 22, 24 32 T 44 32 T 60 32"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M4 40 Q 14 30, 24 40 T 44 40 T 60 40"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
          opacity="0.6"
        />
      </svg>
      {/* Sun ray upper-right */}
      <svg
        aria-hidden
        className="absolute hidden lg:block -right-24 top-8 w-16 h-16 text-caribbean-teal-deep/20"
        viewBox="0 0 64 64"
        fill="none"
      >
        <circle cx="32" cy="32" r="10" stroke="currentColor" strokeWidth="1.4" fill="none" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
          const rad = (deg * Math.PI) / 180
          const x1 = 32 + Math.cos(rad) * 16
          const y1 = 32 + Math.sin(rad) * 16
          const x2 = 32 + Math.cos(rad) * 24
          const y2 = 32 + Math.sin(rad) * 24
          return (
            <line
              key={deg}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          )
        })}
      </svg>
      {/* Lower-left palm sketch */}
      <svg
        aria-hidden
        className="absolute hidden lg:block -left-32 bottom-20 w-20 h-20 text-caribbean-teal-deep/18"
        viewBox="0 0 80 80"
        fill="none"
      >
        <path
          d="M40 78 L 40 36"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        {[
          'M40 36 Q 18 22, 8 28',
          'M40 36 Q 62 22, 72 28',
          'M40 36 Q 20 14, 16 8',
          'M40 36 Q 60 14, 64 8',
          'M40 36 Q 40 18, 40 6',
        ].map((d, i) => (
          <path
            key={i}
            d={d}
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            fill="none"
          />
        ))}
      </svg>
    </>
  )
}

// ─── Doodle wallpaper (inspired by WhatsApp's iconic background) ────

function DoodleWallpaper() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 pointer-events-none opacity-[0.28]"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='84' height='84' viewBox='0 0 84 84'><g fill='none' stroke='%23a89882' stroke-width='1' stroke-linecap='round' opacity='0.5'><circle cx='12' cy='14' r='2'/><path d='M30 22 q4 -3 8 0 t8 0' /><path d='M58 12 l3 3 l3 -3 l-3 -3 z' /><circle cx='72' cy='28' r='1.5'/><path d='M14 44 q3 -4 6 0' /><path d='M40 50 c2 -2 4 -2 6 0' /><circle cx='66' cy='52' r='2'/><path d='M22 72 l4 -2 l-2 4 z' /><path d='M48 76 q3 -3 6 0' /><circle cx='78' cy='70' r='1.5'/></g></svg>\")",
        backgroundSize: '84px 84px',
      }}
    />
  )
}

// ─── Date chip ──────────────────────────────────────────────────────

function DateChip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center my-2">
      <span
        className="text-[10.5px] font-medium text-near-black/55 px-2.5 py-1 rounded-md uppercase tracking-wider"
        style={{
          background: 'rgba(225,217,201,0.85)',
          boxShadow: '0 1px 1px rgba(14,26,26,0.06)',
        }}
      >
        {children}
      </span>
    </div>
  )
}

// ─── Message bubble ─────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.from === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[78%] px-3 py-2 relative ${
          isUser ? 'rounded-2xl rounded-br-md' : 'rounded-2xl rounded-bl-md'
        }`}
        style={{
          background: isUser
            ? 'linear-gradient(180deg, #E2FAC9 0%, #DCF8C6 100%)'
            : 'linear-gradient(180deg, #FFFFFF 0%, #FAFAF8 100%)',
          boxShadow:
            '0 1px 0.5px rgba(14,26,26,0.13), 0 1px 0 rgba(255,255,255,0.6) inset',
        }}
      >
        {/* Bubble tail */}
        <span
          aria-hidden
          className="absolute bottom-0 w-3 h-3"
          style={{
            [isUser ? 'right' : 'left']: '-4px',
            background: isUser ? '#DCF8C6' : '#FAFAF8',
            clipPath: isUser
              ? 'polygon(0 0, 100% 100%, 0 100%)'
              : 'polygon(100% 0, 100% 100%, 0 100%)',
          }}
        />
        <p className="text-[13.5px] text-near-black leading-snug whitespace-pre-wrap relative">
          {message.text}
        </p>
        <div className="flex items-center justify-end gap-1 mt-0.5 relative">
          <span className="text-[9.5px] text-near-black/50">{message.time}</span>
          {isUser && <DoubleCheckIcon />}
        </div>
      </div>
    </div>
  )
}

function DoubleCheckIcon() {
  // Animate from single check to double check — like real WhatsApp delivery
  return (
    <motion.svg
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.4, duration: 0.3 }}
      width="14"
      height="10"
      viewBox="0 0 14 10"
      fill="none"
      className="text-[#34B7F1]"
    >
      <motion.path
        d="M1 5l2.5 2.5L7 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, delay: 0.2 }}
      />
      <motion.path
        d="M6 5l2.5 2.5L13 1.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, delay: 0.55 }}
      />
    </motion.svg>
  )
}

function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div
        className="rounded-2xl rounded-bl-md px-4 py-2.5 relative"
        style={{
          background: 'linear-gradient(180deg, #FFFFFF 0%, #FAFAF8 100%)',
          boxShadow:
            '0 1px 0.5px rgba(14,26,26,0.13), 0 1px 0 rgba(255,255,255,0.6) inset',
        }}
      >
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-near-black/45 animate-[typing-dot_1.2s_ease-in-out_infinite]" />
          <span
            className="w-1.5 h-1.5 rounded-full bg-near-black/45 animate-[typing-dot_1.2s_ease-in-out_infinite]"
            style={{ animationDelay: '0.18s' }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-near-black/45 animate-[typing-dot_1.2s_ease-in-out_infinite]"
            style={{ animationDelay: '0.36s' }}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Caye avatar ────────────────────────────────────────────────────

function CayeAvatar({ size }: { size: number }) {
  return (
    <div
      className="rounded-full flex items-center justify-center flex-shrink-0 relative"
      style={{
        width: size,
        height: size,
        background:
          'radial-gradient(circle at 30% 25%, #FFFCF5 0%, #FAF7F2 65%, #EFE9DC 100%)',
        boxShadow:
          '0 1px 2px rgba(14,26,26,0.18), inset 0 0 0 1px rgba(14,26,26,0.06), inset 0 -1px 1px rgba(14,26,26,0.05)',
      }}
    >
      <span
        className="italic text-caribbean-teal-deep font-normal leading-none"
        style={{
          fontFamily: 'var(--font-instrument)',
          fontSize: size * 0.66,
          marginTop: size * 0.04,
        }}
      >
        c
      </span>
    </div>
  )
}

// ─── Icons ──────────────────────────────────────────────────────────

function ChevronLeftIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function VideoIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="opacity-90"
    >
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  )
}

function PhoneIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="opacity-90"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="white"
      className="opacity-85"
    >
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  )
}

function SignalIcon() {
  return (
    <svg width="14" height="10" viewBox="0 0 16 12" fill="white">
      <rect x="0" y="8" width="2.5" height="4" rx="0.5" />
      <rect x="4" y="6" width="2.5" height="6" rx="0.5" />
      <rect x="8" y="3" width="2.5" height="9" rx="0.5" />
      <rect x="12" y="0" width="2.5" height="12" rx="0.5" opacity="0.45" />
    </svg>
  )
}

function WifiIcon() {
  return (
    <svg width="14" height="10" viewBox="0 0 16 12" fill="white">
      <path d="M8 11c0.55 0 1-0.45 1-1s-0.45-1-1-1-1 0.45-1 1 0.45 1 1 1zM4.5 7.5l1.4 1.4c1.16-1.16 3.04-1.16 4.2 0L11.5 7.5c-1.94-1.94-5.06-1.94-7 0zm-3-3l1.4 1.4c2.81-2.81 7.39-2.81 10.2 0L14.5 4.5c-3.59-3.59-9.41-3.59-13 0z" />
    </svg>
  )
}

function BatteryIcon() {
  return (
    <svg width="22" height="10" viewBox="0 0 26 12" fill="none">
      <rect
        x="0.5"
        y="0.5"
        width="22"
        height="11"
        rx="2.5"
        stroke="white"
        strokeOpacity="0.6"
        fill="none"
      />
      <rect x="2" y="2" width="16" height="8" rx="1.5" fill="white" />
      <rect x="23" y="4" width="2" height="4" rx="0.5" fill="white" opacity="0.6" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[#075E54]/55 flex-shrink-0"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}
