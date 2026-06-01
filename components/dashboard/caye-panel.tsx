"use client"

import { useState, useRef, useEffect } from "react"
import { getSession } from "@/lib/supabase"
import { cn } from "@/lib/utils"

interface CayePanelProps {
  open: boolean
  onClose: () => void
  conversationCount?: number
}

type Message = {
  from: "user" | "caye"
  text: string
}

const CayeMark = ({ size = 16 }: { size?: number }) => (
  <span
    style={{
      width: size,
      height: size,
      fontSize: size * 0.55,
      background: "conic-gradient(from 0deg, var(--tc-teal), var(--tc-sun), var(--tc-coral), var(--tc-teal))",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "50%",
      flexShrink: 0,
      fontWeight: "bold",
      color: "white",
    }}
  >
    C
  </span>
)

export function CayePanel({ open, onClose, conversationCount = 0 }: CayePanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [messages, isLoading])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 350)
  }, [open])

  const send = async () => {
    const text = input.trim()
    if (!text || isLoading) return
    setInput("")

    setMessages((prev) => [...prev, { from: "user", text }])
    setIsLoading(true)

    try {
      const { session } = await getSession()
      if (!session) throw new Error("Not authenticated")

      const history = messages.map((m) => ({
        role: m.from === "user" ? "user" : "assistant",
        content: m.text,
      }))

      const res = await fetch("/api/ai/assistant/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ query: text, category: "caye", history }),
      })

      const data = await res.json()
      setMessages((prev) => [
        ...prev,
        { from: "caye", text: data.response || "Something went wrong — try again." },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        { from: "caye", text: "I couldn't connect right now. Try again in a moment." },
      ])
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <aside className={cn("caye-panel", open && "open")}>
      <header className="cp-head">
        <div className="cp-title">
          <CayeMark size={28} />
          <div>
            <div className="cp-name">Caye</div>
            <div className="cp-status">
              <span className="cp-pulse" />
              Listening
            </div>
          </div>
        </div>
        <button className="cp-close" onClick={onClose}>×</button>
      </header>

      <div className="cp-context">
        <span className="cp-context-label">Context</span>
        <span className="cp-context-chip">
          <span className="text-[10px]">💬</span> {conversationCount} chats
        </span>
        <span className="cp-context-chip">
          <span className="text-[10px]">📅</span> Calendar
        </span>
        <span className="cp-context-chip">
          <span className="text-[10px]">📋</span> Recent messages
        </span>
      </div>

      <div className="cp-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="cp-msg caye">
            <CayeMark size={20} />
            <div className="cp-msg-body">
              <div className="cp-msg-bubble">
                What can I help you with? Ask me about your conversations, how to respond to a customer, or anything about your bookings.
              </div>
              <div className="cp-quick">
                {[
                  "What's waiting on me?",
                  "Any urgent messages?",
                  "Draft a follow-up",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => {
                      setInput(q)
                      setTimeout(() => inputRef.current?.focus(), 50)
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={cn("cp-msg", m.from)}>
            {m.from === "caye" && <CayeMark size={20} />}
            <div className="cp-msg-body">
              <div className="cp-msg-bubble">{m.text}</div>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="cp-msg caye">
            <CayeMark size={20} />
            <div className="cp-msg-body">
              <div className="cp-msg-bubble" style={{ color: "var(--ink-mute)" }}>
                Thinking…
              </div>
            </div>
          </div>
        )}
      </div>

      <footer className="cp-foot">
        <div className="cp-input">
          <CayeMark size={16} />
          <input
            ref={inputRef}
            placeholder="Ask Caye anything…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            disabled={isLoading}
          />
          <button
            className="cp-send"
            onClick={send}
            disabled={isLoading || !input.trim()}
          >
            ↵
          </button>
        </div>
        <div className="cp-foot-meta">
          <span>configure tone in Settings</span>
        </div>
      </footer>
    </aside>
  )
}
