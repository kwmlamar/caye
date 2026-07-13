'use client'

// Interactive WhatsApp demo — the landing's central product proof, per
// the locked positioning that WhatsApp is Caye's daily operator surface.
// Docked directly in the hero below the CTA (Viktor/Tomo-style: lead
// with the real product surface, not a screenshot further down the
// page), cropped by the hero's overflow-hidden edge.
//
// Design intent: a tactile artifact — a phone sitting in soft Caribbean
// light, not pasted on a background. Refined hardware, doodle
// wallpaper, ground shadow, gentle float, auto-playing intro.

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, useInView, useReducedMotion } from 'framer-motion'

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
    prompt: "What's on the calendar today?",
    reply:
      '3 confirmed tours — Maya at 9 AM, James’s group at 1 PM, and the held 4 PM slot if Daniel takes it.',
  },
  {
    prompt: 'Anything need my call?',
    reply:
      "Just Daniel — he replied asking if Sunday afternoon works for the charter. Needs your call since Sunday's your day off.",
  },
  {
    prompt: "What's today looking like?",
    reply:
      "Steady. $1,470 confirmed from the 3 tours. Daniel's custom charter would add $850 if Sunday works for you.",
  },
]

// Opening conversation. Auto-plays with typing indicators when the phone
// scrolls into view — a morning briefing → operator question → Caye reply
// loop — then invites the visitor to tap a suggestion. Reduced-motion
// visitors get the full conversation statically.
const INITIAL_MESSAGES: Message[] = [
  {
    id: 'i1',
    from: 'caye',
    text:
      "Morning. 2 bookings confirmed overnight — Maya at 9 AM Saturday and James's group at 1 PM. Held one from Daniel asking about a custom Sunday charter.",
    time: '6:45 AM',
  },
  {
    id: 'i2',
    from: 'user',
    text: 'Send Daniel a quote',
    time: '6:48 AM',
  },
  {
    id: 'i3',
    from: 'caye',
    text:
      "Done. Sent our standard rate and asked his preferred date. I'll keep you posted when he replies.",
    time: '6:48 AM',
  },
  {
    id: 'i4',
    from: 'caye',
    text: 'Anything else? Tap one below to keep going.',
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

// Per-message autoplay pacing. Caye's messages get a typing pause scaled
// to length (reads as her composing); the operator's reply lands after a
// short read-then-respond beat.
function typingDelay(m: Message): number {
  if (m.from === 'user') return 900
  return Math.min(800 + m.text.length * 9, 2000)
}

export default function WhatsAppMockup() {
  const prefersReducedMotion = useReducedMotion()
  const [messages, setMessages] = useState<Message[]>([])
  const [introDone, setIntroDone] = useState(false)
  const [usedPrompts, setUsedPrompts] = useState<Set<string>>(new Set())
  const [typing, setTyping] = useState(false)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const phoneRef = useRef<HTMLDivElement>(null)
  const phoneInView = useInView(phoneRef, { once: true, margin: '-180px' })
  const introStarted = useRef(false)

  // Auto-play the opening conversation once the phone is on screen.
  useEffect(() => {
    if (!phoneInView || introStarted.current) return
    introStarted.current = true

    if (prefersReducedMotion) {
      setMessages(INITIAL_MESSAGES)
      setIntroDone(true)
      return
    }

    let cancelled = false
    ;(async () => {
      await new Promise((r) => setTimeout(r, 600))
      for (const m of INITIAL_MESSAGES) {
        if (cancelled) return
        if (m.from === 'caye') setTyping(true)
        await new Promise((r) => setTimeout(r, typingDelay(m)))
        if (cancelled) return
        setTyping(false)
        setMessages((prev) => [...prev, m])
      }
      await new Promise((r) => setTimeout(r, 400))
      if (!cancelled) setIntroDone(true)
    })()
    return () => {
      cancelled = true
    }
  }, [phoneInView, prefersReducedMotion])

  // Keep the chat pinned to the latest message — scroll the chat area
  // directly (scrollIntoView could yank the page while autoplay runs).
  useEffect(() => {
    const el = scrollAreaRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
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
    <div className="relative mx-auto" style={{ width: 'fit-content' }}>
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
            ref={phoneRef}
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

                {/* WhatsApp header — dark theme uses a dark slate bar,
                    not the light theme's teal. */}
                <div
                  className="relative px-3 pt-2 pb-3 flex items-center gap-3 z-10"
                  style={{
                    background:
                      'linear-gradient(180deg, #1F2C34 0%, #182229 100%)',
                    boxShadow: '0 1px 0 rgba(0,0,0,0.25)',
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
                <div
                  ref={scrollAreaRef}
                  className="relative flex-1 overflow-y-auto px-3 py-3 space-y-1.5"
                >
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
                  </div>
                </div>

                {/* Suggestion bar or CTA — hidden until the opening
                    conversation finishes playing */}
                <div className="relative z-10">
                  {!introDone ? null : !allDone ? (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                      className="border-t border-white/10 px-3 py-2.5 space-y-1.5"
                      style={{ background: 'rgba(17,27,33,0.95)' }}
                    >
                      <div className="text-center font-mono text-[8.5px] uppercase tracking-[0.18em] text-white/35 mb-1.5">
                        Tap to reply
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
                          whileHover={{ y: -1 }}
                          whileTap={{ scale: 0.985 }}
                          className={`block w-full text-left text-white/85 text-[12px] px-3 py-1.5 rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-shadow ${
                            firstTapNotYet && idx === 0
                              ? 'animate-[bubble-invite_2.4s_ease-in-out_infinite]'
                              : ''
                          }`}
                          style={{
                            background: 'rgba(0,92,75,0.4)',
                            boxShadow:
                              '0 1px 0 rgba(255,255,255,0.06) inset, 0 1px 1.5px rgba(0,0,0,0.2)',
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span>{opt.prompt}</span>
                            <SendIcon />
                          </div>
                        </motion.button>
                      ))}
                    </motion.div>
                  ) : (
                    <motion.a
                      href={
                        process.env.NEXT_PUBLIC_CAYE_WHATSAPP_NUMBER
                          ? `https://wa.me/${process.env.NEXT_PUBLIC_CAYE_WHATSAPP_NUMBER}?text=${encodeURIComponent("Hi Caye! I'd like to sign up.")}`
                          : '/signup'
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.4 }}
                      className="block text-white text-center py-4 px-4 font-medium text-[14px] transition-colors flex items-center justify-center gap-2"
                      style={{
                        background:
                          'linear-gradient(180deg, #06705f 0%, #005C4B 100%)',
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
  )
}

// ─── Phone frame ─────────────────────────────────────────────────────

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    // Shrinks below 380px so the phone never clips on narrow viewports —
    // the target customer is reading this on a phone.
    <div className="relative" style={{ width: 'min(380px, calc(100vw - 40px))' }}>
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
          style={{ background: '#0B141A' }}
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

// ─── Doodle wallpaper (inspired by WhatsApp's iconic background) ────

// Loose approximation of WhatsApp's iconic doodle wallpaper — a scatter
// of small varied icons (sparkle, camera, smiley, envelope, note, heart,
// ball, speech bubble, flower, confetti, pin) rather than plain abstract
// shapes, so it reads as the real chat background instead of noise.
function DoodleWallpaper() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 pointer-events-none opacity-[0.4]"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'><g fill='none' stroke='%232A3942' stroke-width='1' stroke-linecap='round' stroke-linejoin='round' opacity='0.6'>" +
          "<g transform='translate(16,18)'><path d='M0 -6 L1.2 -1.2 L6 0 L1.2 1.2 L0 6 L-1.2 1.2 L-6 0 L-1.2 -1.2 Z'/><line x1='6' y1='-6' x2='10' y2='-10'/><circle cx='12' cy='-12' r='0.8' fill='%232A3942' stroke='none'/></g>" +
          "<g transform='translate(120,20)'><rect x='-8' y='-5' width='16' height='11' rx='2'/><rect x='-3' y='-8' width='6' height='3' rx='1'/><circle cx='0' cy='0.5' r='3'/></g>" +
          "<g transform='translate(72,50)'><circle r='7'/><circle cx='-2.5' cy='-2' r='0.7' fill='%232A3942' stroke='none'/><circle cx='2.5' cy='-2' r='0.7' fill='%232A3942' stroke='none'/><path d='M-3 2.5 Q0 5 3 2.5'/></g>" +
          "<g transform='translate(140,65)'><rect x='-8' y='-5.5' width='16' height='11' rx='1.5'/><path d='M-8 -5 L0 1 L8 -5'/></g>" +
          "<g transform='translate(26,82) rotate(-12)'><line x1='4' y1='-10' x2='4' y2='6'/><path d='M4 -10 Q9 -9 9 -5'/><ellipse cx='1.5' cy='7' rx='2.4' ry='1.8'/></g>" +
          "<g transform='translate(100,92)'><path d='M0 5 C-6 0 -6 -5 -2 -5 C0 -5 0 -3 0 -3 C0 -3 0 -5 2 -5 C6 -5 6 0 0 5 Z'/></g>" +
          "<g transform='translate(145,118)'><circle r='6'/><path d='M0 -6 L1.9 -2.8 L5.7 -1.9 L3.5 1.1 L4.4 5.7 L0 3.5 L-4.4 5.7 L-3.5 1.1 L-5.7 -1.9 L-1.9 -2.8 Z' stroke-width='0.7'/></g>" +
          "<g transform='translate(15,128)'><rect x='-8' y='-6' width='16' height='10' rx='4'/><path d='M-3 4 L-5 8 L-1 4'/></g>" +
          "<g transform='translate(66,138)'><circle r='1.6' fill='%232A3942' stroke='none'/><circle cx='0' cy='-4' r='2'/><circle cx='3.4' cy='-2' r='2'/><circle cx='3.4' cy='2' r='2'/><circle cx='0' cy='4' r='2'/><circle cx='-3.4' cy='2' r='2'/><circle cx='-3.4' cy='-2' r='2'/></g>" +
          "<g transform='translate(116,148)'><circle r='0.9' fill='%232A3942' stroke='none'/><line x1='0' y1='0' x2='6' y2='-3'/><line x1='0' y1='0' x2='7' y2='1'/><line x1='0' y1='0' x2='5' y2='5'/><line x1='0' y1='0' x2='-1' y2='7'/><circle cx='7' cy='-4' r='0.7' fill='%232A3942' stroke='none'/><circle cx='8' cy='2' r='0.6' fill='%232A3942' stroke='none'/></g>" +
          "<g transform='translate(155,46)'><path d='M0 -6 C3 -6 5 -4 5 -1 C5 3 0 8 0 8 C0 8 -5 3 -5 -1 C-5 -4 -3 -6 0 -6 Z'/><circle r='1.6'/></g>" +
          "<g transform='translate(92,20)'><path d='M0 -4 L0.8 -0.8 L4 0 L0.8 0.8 L0 4 L-0.8 0.8 L-4 0 L-0.8 -0.8 Z'/></g>" +
          "</g></svg>\")",
        backgroundSize: '160px 160px',
      }}
    />
  )
}

// ─── Date chip ──────────────────────────────────────────────────────

function DateChip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center my-2">
      <span
        className="text-[10.5px] font-medium text-white/60 px-2.5 py-1 rounded-md uppercase tracking-wider"
        style={{
          background: 'rgba(31,44,52,0.85)',
          boxShadow: '0 1px 1px rgba(0,0,0,0.2)',
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
            ? 'linear-gradient(180deg, #075E54 0%, #005C4B 100%)'
            : 'linear-gradient(180deg, #202C33 0%, #1C262D 100%)',
          boxShadow:
            '0 1px 0.5px rgba(0,0,0,0.35), 0 1px 0 rgba(255,255,255,0.03) inset',
        }}
      >
        {/* Bubble tail */}
        <span
          aria-hidden
          className="absolute bottom-0 w-3 h-3"
          style={{
            [isUser ? 'right' : 'left']: '-4px',
            background: isUser ? '#005C4B' : '#1C262D',
            clipPath: isUser
              ? 'polygon(0 0, 100% 100%, 0 100%)'
              : 'polygon(100% 0, 100% 100%, 0 100%)',
          }}
        />
        <p className="text-[13.5px] text-[#E9EDEF] leading-snug whitespace-pre-wrap relative">
          {message.text}
        </p>
        <div className="flex items-center justify-end gap-1 mt-0.5 relative">
          <span className="text-[9.5px] text-white/45">{message.time}</span>
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
          background: 'linear-gradient(180deg, #202C33 0%, #1C262D 100%)',
          boxShadow:
            '0 1px 0.5px rgba(0,0,0,0.35), 0 1px 0 rgba(255,255,255,0.03) inset',
        }}
      >
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-white/45 animate-[typing-dot_1.2s_ease-in-out_infinite]" />
          <span
            className="w-1.5 h-1.5 rounded-full bg-white/45 animate-[typing-dot_1.2s_ease-in-out_infinite]"
            style={{ animationDelay: '0.18s' }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-white/45 animate-[typing-dot_1.2s_ease-in-out_infinite]"
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
      className="rounded-full flex-shrink-0 relative"
      style={{
        width: size,
        height: size,
        background:
          'radial-gradient(circle at 22% 22%, rgba(255,255,255,0.6), transparent 38%), radial-gradient(circle at 18% 20%, #7DC9CB 0%, transparent 48%), radial-gradient(circle at 88% 15%, #FFD68F 0%, transparent 52%), radial-gradient(circle at 82% 88%, #00778B 0%, transparent 58%), radial-gradient(circle at 12% 85%, #A8DCC0 0%, transparent 52%), #F5E8D0',
        boxShadow:
          '0 1px 2px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    />
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
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-white/55 flex-shrink-0"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}
