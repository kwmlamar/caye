'use client'

// Interactive WhatsApp demo. Replaces the dashboard mockup as the
// landing's product proof, because per the locked positioning, WhatsApp
// is Caye's daily operator surface — not the dashboard.
//
// Pattern is borrowed from lindy.ai's iMessage demo: pre-filled
// suggestion bubbles at the bottom. Tap one → it becomes a sent
// message, Caye "types," then replies. Once all suggestions are used,
// the input bar swaps to a Try-Caye CTA.

import { useEffect, useRef, useState } from 'react'

interface Message {
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
    from: 'caye',
    text: "Hey — I'm Caye. I'll handle your DMs and bookings in your voice.",
    time: '7:42 AM',
  },
  {
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
    setMessages((prev) => [
      ...prev,
      { from: 'user', text: option.prompt, time: nowTime() },
    ])
    setTyping(true)
    await new Promise((r) => setTimeout(r, 1100))
    setTyping(false)
    setMessages((prev) => [
      ...prev,
      { from: 'caye', text: option.reply, time: nowTime() },
    ])
  }

  const availableOptions = CONVERSATIONS.filter(
    (c) => !usedPrompts.has(c.prompt)
  )
  const allDone = availableOptions.length === 0

  return (
    <section className="relative bg-cream py-24 md:py-32 px-6 overflow-hidden">
      <div className="absolute inset-x-0 top-1/3 h-[400px] bg-caribbean-teal/[0.05] blur-[120px] pointer-events-none" />

      <div className="relative max-w-6xl mx-auto">
        {/* Editorial caption */}
        <div className="text-center mb-14 md:mb-16">
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
          <p className="mt-5 font-newsreader font-light text-[1.1rem] md:text-[1.2rem] text-near-black/70 max-w-md mx-auto leading-snug">
            Set up the dashboard once. After that, Caye lives in WhatsApp &mdash; talk to her like an employee.
          </p>
        </div>

        {/* Phone frame */}
        <div className="mx-auto w-full max-w-[380px]">
          <div className="rounded-[44px] bg-near-black p-[10px] shadow-[0_30px_80px_-24px_rgba(14,26,26,0.45)]">
            <div className="relative rounded-[36px] overflow-hidden bg-[#ECE5DD] h-[680px] flex flex-col">
              {/* Status bar */}
              <div className="bg-[#075E54] px-6 pt-3 pb-1 flex items-center justify-between text-white">
                <span className="font-semibold text-[13px]">9:41</span>
                <div className="flex items-center gap-1.5">
                  <SignalIcon />
                  <WifiIcon />
                  <BatteryIcon />
                </div>
              </div>

              {/* WhatsApp header */}
              <div className="bg-[#075E54] px-3 pb-3 pt-2 flex items-center gap-3">
                <ChevronLeftIcon />
                <CayeAvatar size={38} />
                <div className="flex-1 min-w-0">
                  <div className="text-white text-[14.5px] font-medium leading-tight">
                    Caye
                  </div>
                  <div className="text-white/70 text-[11px] leading-tight mt-0.5">
                    {typing ? 'typing…' : 'online'}
                  </div>
                </div>
                <VideoIcon />
                <PhoneIcon />
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5 bg-[#ECE5DD]">
                {messages.map((m, i) => (
                  <MessageBubble key={i} message={m} />
                ))}
                {typing && <TypingBubble />}
                <div ref={messagesEndRef} />
              </div>

              {/* Suggestion bar or CTA */}
              {!allDone ? (
                <div className="bg-[#F0F0F0] border-t border-near-black/10 px-3 py-3 space-y-2">
                  <div className="text-center font-mono text-[9px] uppercase tracking-[0.18em] text-near-black/40 mb-2">
                    Tap a message
                  </div>
                  {availableOptions.map((opt) => (
                    <button
                      key={opt.prompt}
                      onClick={() => handleTap(opt)}
                      disabled={typing}
                      className="block w-full text-left bg-[#DCF8C6] text-near-black text-[13px] px-3.5 py-2.5 rounded-2xl rounded-br-md hover:bg-[#cdefb5] active:bg-[#bce5a0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-[0_1px_2px_rgba(14,26,26,0.08)]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span>{opt.prompt}</span>
                        <SendIcon />
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <a
                  href="/signup"
                  className="bg-[#075E54] text-white text-center py-4 px-4 font-medium text-[14px] hover:bg-[#0a7565] transition-colors flex items-center justify-center gap-2"
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
                </a>
              )}
            </div>
          </div>
        </div>

        <p className="mt-8 text-center font-newsreader italic text-[14px] text-near-black/55 max-w-lg mx-auto">
          No workflows to build. No automations to wire. You message Caye like
          a coworker, and she figures the rest out.
        </p>
      </div>
    </section>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.from === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[78%] px-3 py-2 shadow-[0_1px_1.5px_rgba(14,26,26,0.13)] ${
          isUser
            ? 'bg-[#DCF8C6] rounded-2xl rounded-br-md'
            : 'bg-white rounded-2xl rounded-bl-md'
        }`}
      >
        <p className="text-[13.5px] text-near-black leading-snug whitespace-pre-wrap">
          {message.text}
        </p>
        <div className="flex items-center justify-end gap-1 mt-0.5">
          <span className="text-[9.5px] text-near-black/45">{message.time}</span>
          {isUser && (
            <svg
              width="14"
              height="10"
              viewBox="0 0 14 10"
              fill="none"
              className="text-[#34B7F1]"
            >
              <path
                d="M1 5l2.5 2.5L7 4M6 5l2.5 2.5L13 1.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>
    </div>
  )
}

function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div className="bg-white rounded-2xl rounded-bl-md px-4 py-2.5 shadow-[0_1px_1.5px_rgba(14,26,26,0.13)]">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-near-black/40 animate-[typing-dot_1.2s_ease-in-out_infinite]" />
          <span
            className="w-1.5 h-1.5 rounded-full bg-near-black/40 animate-[typing-dot_1.2s_ease-in-out_infinite]"
            style={{ animationDelay: '0.2s' }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-near-black/40 animate-[typing-dot_1.2s_ease-in-out_infinite]"
            style={{ animationDelay: '0.4s' }}
          />
        </div>
      </div>
    </div>
  )
}

function CayeAvatar({ size }: { size: number }) {
  return (
    <div
      className="rounded-full bg-cream flex items-center justify-center flex-shrink-0 shadow-[inset_0_0_0_1px_rgba(14,26,26,0.08)]"
      style={{ width: size, height: size }}
    >
      <span
        className="italic text-caribbean-teal-deep font-normal leading-none"
        style={{
          fontFamily: 'var(--font-instrument)',
          fontSize: size * 0.62,
          paddingBottom: size * 0.02,
        }}
      >
        c
      </span>
    </div>
  )
}

function ChevronLeftIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2"
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
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
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
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function SignalIcon() {
  return (
    <svg width="14" height="10" viewBox="0 0 16 12" fill="white">
      <rect x="0" y="8" width="2.5" height="4" rx="0.5" />
      <rect x="4" y="6" width="2.5" height="6" rx="0.5" />
      <rect x="8" y="3" width="2.5" height="9" rx="0.5" />
      <rect x="12" y="0" width="2.5" height="12" rx="0.5" opacity="0.4" />
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
      className="text-near-black/45 flex-shrink-0"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}
