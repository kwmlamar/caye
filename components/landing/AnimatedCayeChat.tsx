"use client"

/**
 * AnimatedCayeChat
 * ----------------
 * Self-contained, looping WhatsApp-style chat mockup for the landing hero.
 * Demonstrates Caye replying to a tour guest in real time.
 *
 * - No controls, no sound. Ambient ~9.6s loop.
 * - Respects prefers-reduced-motion: shows the full final state statically.
 * - Tailwind + small inline <style> block. No external deps beyond React.
 */

import { useState, useEffect } from "react"

const CSS = `
@keyframes cayeBubbleIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.caye-bubble-in { animation: cayeBubbleIn 280ms cubic-bezier(0.22,1,0.36,1) both; }

@keyframes cayeDotPulse {
  0%, 60%, 100% { opacity: 0.35; transform: translateY(0); }
  30%           { opacity: 1;    transform: translateY(-2px); }
}
.caye-typing-dot { animation: cayeDotPulse 1.1s infinite ease-in-out; }

@keyframes cayeSoftPulse { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }
.caye-pulse-soft { animation: cayeSoftPulse 1.6s infinite ease-in-out; }

@keyframes cayeDotGlow {
  0%, 100% { transform: scale(1);   opacity: 1; }
  50%      { transform: scale(1.5); opacity: 0.55; }
}
.caye-dot-glow { animation: cayeDotGlow 1.4s infinite ease-in-out; }

.caye-stack { transition: opacity 400ms ease; }

@media (prefers-reduced-motion: reduce) {
  .caye-bubble-in, .caye-typing-dot, .caye-pulse-soft, .caye-dot-glow { animation: none !important; }
  .caye-stack { transition: none !important; }
}
`

interface Message {
  from: "caye" | "anna"
  text: string
  link?: string
  time: string
}

const MESSAGES: Record<"anna" | "caye1" | "caye2", Message> = {
  anna: {
    from: "anna",
    text:
      "Hi! Saw you on IG — y'all have anything Saturday for a family of 5? First time in Bimini.",
    time: "10:23",
  },
  caye1: {
    from: "caye",
    text:
      "Hi Anna. Saturday 10am we have the North Bimini Heritage Tour open — 2 hours, private for your family of 5, $750.",
    time: "10:24",
  },
  caye2: {
    from: "caye",
    text:
      "Want me to hold the slot? Just send the deposit through here and you're booked: ",
    link: "wetravel.com/bimini/north-heritage",
    time: "10:24",
  },
}

const DoubleTick = () => (
  <svg width="16" height="11" viewBox="0 0 16 11" fill="none" aria-hidden="true" style={{ display: "block" }}>
    <path d="M1 6.1 3.7 8.8 8.6 2.4" stroke="#53bdeb" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6 8.6 10.9 2.2" stroke="#53bdeb" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 6.1 5.9 7" stroke="#d9fdd3" strokeWidth="1.35" strokeLinecap="round" />
  </svg>
)

function Bubble({ msg }: { msg: Message }) {
  const isCaye = msg.from === "caye"
  return (
    <div className={`caye-bubble-in flex ${isCaye ? "justify-end" : "justify-start"}`}>
      <div
        className="relative max-w-[81%] px-2.5 pt-1.5 pb-1"
        style={{
          background: isCaye ? "#d9fdd3" : "#ffffff",
          borderRadius: 8,
          borderTopRightRadius: isCaye ? 2 : 8,
          borderTopLeftRadius: isCaye ? 8 : 2,
          boxShadow: "0 1px 0.5px rgba(11,20,26,0.13)",
        }}
      >
        <span style={{ fontSize: "14.5px", lineHeight: "19px", color: "#111b21", wordBreak: "break-word" }}>
          {msg.link ? (
            <>
              {msg.text}
              <a
                href={"https://" + msg.link}
                onClick={(e) => e.preventDefault()}
                style={{ color: "#027eb5", textDecoration: "underline" }}
              >
                {msg.link}
              </a>
            </>
          ) : (
            msg.text
          )}
          <span style={{ display: "inline-block", width: isCaye ? 64 : 42 }} aria-hidden="true" />
        </span>
        <span
          className="absolute right-2 bottom-1 flex items-center gap-1 select-none"
          style={{ fontSize: "10px", color: "#667781" }}
        >
          {msg.time}
          {isCaye && <DoubleTick />}
        </span>
      </div>
    </div>
  )
}

function TypingBubble() {
  return (
    <div className="caye-bubble-in flex justify-start">
      <div
        className="flex items-center gap-1.5 px-3.5 py-2.5"
        style={{ background: "#ffffff", borderRadius: 8, borderTopLeftRadius: 2, boxShadow: "0 1px 0.5px rgba(11,20,26,0.13)" }}
      >
        {[0, 0.18, 0.36].map((d, i) => (
          <span
            key={i}
            className="caye-typing-dot"
            style={{ width: 7, height: 7, borderRadius: "50%", background: "#9aa6a2", animationDelay: `${d}s` }}
          />
        ))}
      </div>
    </div>
  )
}

export default function AnimatedCayeChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [typing, setTyping] = useState(false)
  const [toast, setToast] = useState(false)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches

    if (reduce) {
      setMessages([MESSAGES.anna, MESSAGES.caye1, MESSAGES.caye2])
      setToast(true)
      return
    }

    const token: { cancelled: boolean; timer: ReturnType<typeof setTimeout> | null } = {
      cancelled: false,
      timer: null,
    }
    const sleep = (ms: number) =>
      new Promise<void>((res) => {
        token.timer = setTimeout(res, ms)
      })

    ;(async () => {
      while (!token.cancelled) {
        setFading(false)
        setMessages([])
        setTyping(false)
        setToast(false)
        await sleep(650)
        if (token.cancelled) return

        // 1. Anna's inbound message
        setMessages([MESSAGES.anna])
        await sleep(600) // 2. brief pause

        // 3. typing indicator
        setTyping(true)
        await sleep(1200)
        if (token.cancelled) return

        // 4. first Caye reply
        setTyping(false)
        setMessages((m) => [...m, MESSAGES.caye1])
        await sleep(500) // 5. brief pause

        // 6. typing again
        setTyping(true)
        await sleep(900)
        if (token.cancelled) return

        // 7. second Caye reply (with booking link)
        setTyping(false)
        setMessages((m) => [...m, MESSAGES.caye2])
        await sleep(800)
        if (token.cancelled) return

        // 8. system toast pill
        setToast(true)
        await sleep(3000) // 9. hold

        // 10. gentle fade out, then loop
        setFading(true)
        await sleep(420)
      }
    })()

    return () => {
      token.cancelled = true
      if (token.timer) clearTimeout(token.timer)
    }
  }, [])

  return (
    <div
      className="w-full overflow-hidden bg-white select-none"
      style={{
        maxWidth: 392,
        borderRadius: 26,
        boxShadow: "0 30px 60px -22px rgba(13,40,33,0.32), 0 10px 24px -16px rgba(13,40,33,0.28)",
        border: "1px solid rgba(13,40,33,0.06)",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif',
      }}
    >
      <style>{CSS}</style>

      {/* Header */}
      <div className="flex items-center gap-3 px-3.5 py-2.5" style={{ background: "#008069" }}>
        <svg width="11" height="18" viewBox="0 0 11 18" fill="none" className="shrink-0 -ml-0.5">
          <path d="M9 1 2 9l7 8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div
          className="shrink-0 grid place-items-center text-white font-semibold"
          style={{ width: 40, height: 40, borderRadius: "50%", background: "linear-gradient(150deg,#3aa78f,#1d6b58)", fontSize: 16 }}
        >
          A
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-white font-semibold truncate" style={{ fontSize: 15.5 }}>
            Anna <span style={{ opacity: 0.78, fontWeight: 400 }}>· cruise guest</span>
          </div>
          <div className="caye-pulse-soft" style={{ fontSize: 12, color: "#cdeee6" }}>
            Caye is replying…
          </div>
        </div>
        <div className="flex items-center gap-4 pr-1 text-white/90 shrink-0">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
            <path d="M15 8.5 22 5v14l-7-3.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <rect x="2" y="5.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
          </svg>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <path d="M6.6 3.8 8.5 8 6.3 10.2a13 13 0 0 0 5.5 5.5L14 13.5l4.2 1.9c.6.3 1 .9 1 1.6V20a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 2 7.2 2 2 0 0 1 4 5h1.1c.7 0 1.3.4 1.5 1z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      {/* Conversation */}
      <div
        className="relative px-3.5 pt-4 pb-4"
        style={{
          minHeight: 470,
          backgroundColor: "#efeae2",
          backgroundImage: "radial-gradient(rgba(11,20,26,0.028) 1px, transparent 1px)",
          backgroundSize: "17px 17px",
        }}
      >
        <div className="caye-stack flex flex-col gap-2" style={{ opacity: fading ? 0 : 1 }}>
          {messages.map((m, i) => (
            <Bubble key={i} msg={m} />
          ))}
          {typing && <TypingBubble />}
          {toast && (
            <div className="caye-bubble-in flex justify-center pt-2">
              <div
                className="flex items-center gap-2 px-3 py-1.5"
                style={{ background: "rgba(255,255,255,0.96)", borderRadius: 999, boxShadow: "0 1px 3px rgba(11,20,26,0.18)" }}
              >
                <span className="caye-dot-glow" style={{ width: 7, height: 7, borderRadius: "50%", background: "#008069" }} />
                <span style={{ fontSize: 11.5, color: "#3b4a46", fontWeight: 500 }}>
                  Caye replied for you · slot held until paid
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
