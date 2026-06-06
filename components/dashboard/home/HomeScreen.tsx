'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'
import SuggestionChip from '../SuggestionChip'
import SetupChecklist from '../SetupChecklist'
import WhatsAppStatusBanner from '../WhatsAppStatusBanner'
import { RichReply, type CardPayload } from './RichReply'
import { useDashboard } from '@/lib/dashboard-context'

interface Message {
  from: 'user' | 'caye'
  text: string
  timestamp: string
  cards?: CardPayload[]
}

function getFirstName(fullName?: string | null): string | undefined {
  if (!fullName) return undefined
  const first = fullName.trim().split(/\s+/)[0]
  return first || undefined
}

function getGreeting(firstName?: string) {
  const h = new Date().getHours()
  const base = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening'
  return firstName ? `${base}, ${firstName}.` : `${base}.`
}

function parseCayeMessageText(text: string) {
  const parseBold = (str: string): React.ReactNode[] => {
    const parts = str.split('**')
    return parts.map((part, i) =>
      i % 2 === 1 ? (
        <strong key={i} className="font-semibold text-near-black">{part}</strong>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      )
    )
  }

  // A line of only dashes / asterisks / underscores / equals is a rule —
  // never a list item (this is what produced the stray "• --" bullets).
  const isRule = (s: string) => /^([-*_=])\1{2,}$/.test(s.trim())
  const isBullet = (s: string) => {
    const t = s.trim()
    return /^[-•*]\s+/.test(t) && !isRule(t)
  }
  // A line that is entirely bold (e.g. "**Option 3 — Heritage Tour**") reads
  // as a section heading rather than emphasised body copy.
  const asHeading = (s: string) => {
    const m = s.trim().match(/^\*\*(.+?)\*\*$/)
    return m && !m[1].includes('**') ? m[1] : null
  }

  const blocks = text.split(/\n{2,}/)

  return blocks.map((block, bi) => {
    const lines = block.split('\n')

    if (lines.length === 1 && isRule(lines[0])) {
      return <hr key={bi} className="my-5 border-0 h-px bg-near-black/[0.08]" />
    }

    const out: React.ReactNode[] = []
    let bullets: React.ReactNode[] = []
    const flushBullets = () => {
      if (!bullets.length) return
      out.push(
        <ul key={`ul-${bi}-${out.length}`} className="my-3 space-y-2">
          {bullets}
        </ul>
      )
      bullets = []
    }

    lines.forEach((line, li) => {
      const t = line.trim()
      if (!t) return

      if (isRule(t)) {
        flushBullets()
        out.push(<hr key={`hr-${bi}-${li}`} className="my-4 border-0 h-px bg-near-black/[0.08]" />)
        return
      }

      if (isBullet(t)) {
        const clean = t.replace(/^[-•*]\s+/, '')
        bullets.push(
          <li
            key={li}
            className="relative pl-5 leading-[1.6] text-near-black/80 before:absolute before:left-0 before:top-[0.7em] before:h-[5px] before:w-[5px] before:rounded-full before:bg-[#0FB5A1]/80"
          >
            {parseBold(clean)}
          </li>
        )
        return
      }

      const heading = asHeading(t)
      if (heading) {
        flushBullets()
        out.push(
          <p
            key={li}
            className="font-newsreader font-semibold text-[17px] leading-snug text-near-black mt-5 first:mt-0 mb-1.5"
          >
            {heading}
          </p>
        )
        return
      }

      flushBullets()
      out.push(
        <p key={li} className="mb-3.5 last:mb-0 leading-[1.72] text-near-black/80">
          {parseBold(line)}
        </p>
      )
    })

    flushBullets()
    return <React.Fragment key={bi}>{out}</React.Fragment>
  })
}

export default function HomeScreen() {
  const { workspaceId } = useWorkspace()
  const { setPanelScreen, setPanelOpen, panelOpen } = useDashboard()
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [contextText, setContextText] = useState('Caye is running. Ask her anything.')
  const [userName, setUserName] = useState<string | undefined>(undefined)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const discoveryPolledRef = useRef(false)

  // Load user's name from auth session
  useEffect(() => {
    async function loadUserName() {
      try {
        const { data: { session } } = await getSupabase().auth.getSession()
        const user = session?.user
        if (user?.user_metadata?.full_name) {
          setUserName(user.user_metadata.full_name)
        } else if (user?.email) {
          setUserName(user.email.split('@')[0])
        }
      } catch (err) {
        console.error('Failed to load user name:', err)
      }
    }
    loadUserName()
  }, [])

  // Fetch real workspace context for the tagline (held, today's bookings, overnight handled)
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    async function loadContext() {
      try {
        const { data: { session } } = await getSupabase().auth.getSession()
        const token = session?.access_token || ''
        const res = await fetch(`/api/caye/home-summary?workspaceId=${workspaceId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok || cancelled) return
        const { heldCount = 0, todayBookings = 0, overnightHandled = 0 } =
          (await res.json()) as { heldCount?: number; todayBookings?: number; overnightHandled?: number }

        if (heldCount > 0) {
          setContextText(`${heldCount} ${heldCount > 1 ? 'messages are' : 'message is'} waiting on your call.`)
        } else if (todayBookings > 0) {
          setContextText(`${todayBookings} booking${todayBookings > 1 ? 's' : ''} on the schedule today.`)
        } else if (overnightHandled > 0) {
          setContextText(`Caye handled ${overnightHandled} message${overnightHandled > 1 ? 's' : ''} overnight. Inbox is clear.`)
        } else {
          setContextText('Caye is running. Ask her anything.')
        }
      } catch (err) {
        console.error('Failed to load greeting context:', err)
        setContextText('Caye is running. Ask her anything.')
      }
    }

    loadContext()
    const onFocus = () => loadContext()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [workspaceId])

  type DbMessage = {
    id: string
    role: 'user' | 'caye'
    content: string
    cards: CardPayload[] | null
    created_at: string
  }

  const fetchMessagesForThread = useCallback(async (threadId: string) => {
    const { data: { session } } = await getSupabase().auth.getSession()
    const token = session?.access_token || ''
    const res = await fetch(`/api/caye/threads/${threadId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 404) {
      // Thread was deleted elsewhere — drop it and fall back to empty state.
      localStorage.removeItem(`caye_active_thread_id_${workspaceId}`)
      setActiveThreadId(null)
      setMessages([])
      return
    }
    if (!res.ok) {
      setMessages([])
      return
    }
    const rows = (await res.json()) as DbMessage[]
    setMessages(rows.map(r => ({
      from: r.role,
      text: r.content,
      timestamp: r.created_at,
      cards: r.cards || undefined,
    })))
  }, [workspaceId])

  // Initial load: pick up the previously active thread (if any). We do NOT
  // auto-create a thread here — one gets created when the operator sends
  // their first message.
  const loadActiveThread = useCallback(() => {
    if (!workspaceId) return
    const activeId = localStorage.getItem(`caye_active_thread_id_${workspaceId}`)
    if (activeId) {
      setActiveThreadId(activeId)
      fetchMessagesForThread(activeId)
    } else {
      setActiveThreadId(null)
      setMessages([])
    }
  }, [workspaceId, fetchMessagesForThread])

  // After thread loads, poll once for a pending discovery greeting
  useEffect(() => {
    if (!workspaceId || discoveryPolledRef.current) return
    discoveryPolledRef.current = true

    async function checkDiscoveryGreeting() {
      try {
        const supabase = getSupabase()
        const { data: config } = await supabase
          .from('workspace_ai_config')
          .select('metadata')
          .eq('workspace_id', workspaceId)
          .maybeSingle()

        const meta = (config?.metadata as Record<string, unknown> | null) || {}
        const greeting = meta.discovery_greeting as string | undefined
        const status = meta.discovery_status as string | undefined

        if (!greeting || status === 'greeting_shown') return

        // Create a new thread server-side, seeded with the greeting as Caye's first message.
        const { data: { session } } = await getSupabase().auth.getSession()
        const token = session?.access_token || ''
        const res = await fetch('/api/caye/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ workspaceId, initialCayeMessage: greeting, title: 'Welcome' }),
        })
        if (res.ok) {
          const thread = (await res.json()) as { id: string }
          localStorage.setItem(`caye_active_thread_id_${workspaceId}`, thread.id)
          setActiveThreadId(thread.id)
          setMessages([{ from: 'caye', text: greeting, timestamp: new Date().toISOString() }])
          window.dispatchEvent(new CustomEvent('caye-threads-updated'))
        }

        // Mark greeting as shown so we don't re-insert on next load
        await supabase
          .from('workspace_ai_config')
          .upsert(
            {
              workspace_id: workspaceId,
              metadata: { ...meta, discovery_status: 'greeting_shown' },
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'workspace_id' }
          )
      } catch (err) {
        console.error('[HomeScreen] Discovery greeting check failed:', err)
      }
    }

    checkDiscoveryGreeting()
  }, [workspaceId])

  useEffect(() => {
    loadActiveThread()
    const handleSelected = (e: Event) => {
      const threadId = (e as CustomEvent).detail as string
      setActiveThreadId(threadId)
      setMessages([])
      fetchMessagesForThread(threadId)
    }
    window.addEventListener('caye-thread-selected', handleSelected)
    return () => window.removeEventListener('caye-thread-selected', handleSelected)
  }, [loadActiveThread, fetchMessagesForThread])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, typing])

  const onSend = async (textToSend?: string) => {
    const text = (textToSend || input).trim()
    if (!text || typing) return
    if (!textToSend) setInput('')

    const userMsg: Message = {
      from: 'user',
      text,
      timestamp: new Date().toISOString(),
    }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setTyping(true)

    try {
      const client = getSupabase()
      const { data: { session } } = await client.auth.getSession()
      const token = session?.access_token || ''

      const res = await fetch('/api/caye/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text, workspaceId, threadId: activeThreadId }),
      })

      const data = await res.json()
      const replyText = data.reply || "I couldn't reach the server. Let's try again in a bit."

      // The server creates the thread on the first message if we didn't have one.
      if (data.threadId && data.threadId !== activeThreadId) {
        setActiveThreadId(data.threadId)
        localStorage.setItem(`caye_active_thread_id_${workspaceId}`, data.threadId)
      }

      const cayeMsg: Message = {
        from: 'caye',
        text: replyText,
        timestamp: data.createdAt || new Date().toISOString(),
        cards: data.cards || undefined,
      }
      setMessages([...updatedMessages, cayeMsg])

      // Refresh the sidebar so the new title / ordering shows up.
      window.dispatchEvent(new CustomEvent('caye-threads-updated'))

      // Natural language side-panel triggers
      if (replyText.toLowerCase().includes('opening your inbox')) {
        setPanelScreen('chats')
        setPanelOpen(true)
      } else if (replyText.toLowerCase().includes('opening your calendar')) {
        setPanelScreen('calendar')
        setPanelOpen(true)
      }
    } catch (err) {
      console.error(err)
      const errorMsg: Message = {
        from: 'caye',
        text: "I couldn't reach the server. Let's try again in a bit.",
        timestamp: new Date().toISOString(),
      }
      setMessages(prev => [...prev, errorMsg])
    } finally {
      setTyping(false)
    }
  }

  const suggestions = [
    "Catch me up on the last 5 days.",
    "What does my business look like to you?",
    "Show me anything that needs my call.",
    "Draft a reply to the next pending message.",
  ]

  // Handler for the "Catch me up" suggestion. Bypasses /api/caye/chat
  // and hits the catch-up endpoint directly so we can show a structured
  // briefing with the narrative + top-of-list items in one Caye message.
  const onCatchUp = async () => {
    if (typing) return
    const userMsg: Message = {
      from: 'user',
      text: 'Catch me up on the last 5 days.',
      timestamp: new Date().toISOString(),
    }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setTyping(true)

    try {
      const { data: { session } } = await getSupabase().auth.getSession()
      const token = session?.access_token || ''
      const res = await fetch('/api/caye/catch-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, days: 5 }),
      })
      if (!res.ok) throw new Error(`catch-up failed: ${res.status}`)
      const data = (await res.json()) as { text: string }
      const cayeMsg: Message = {
        from: 'caye',
        text: data.text,
        timestamp: new Date().toISOString(),
      }
      setMessages([...updatedMessages, cayeMsg])
    } catch (err) {
      console.error('[HomeScreen] catch-up failed:', err)
      setMessages([
        ...updatedMessages,
        {
          from: 'caye',
          text: "I couldn't pull your last few days right now. Let's try again in a bit.",
          timestamp: new Date().toISOString(),
        },
      ])
    } finally {
      setTyping(false)
    }
  }

  const isEmpty = messages.length === 0

  const renderInputBox = () => {
    return (
      <div className="relative flex items-center bg-white rounded-2xl border border-[rgba(14,26,26,0.1)] focus-within:border-[rgba(14,26,26,0.15)] p-3 transition-colors shadow-[0_2px_8px_-2px_rgba(14,26,26,0.08)]">
        {/* Left Icons: Mic and Attach */}
        <div className="flex items-center gap-1.5 pl-2 text-near-black/30">
          {/* Paperclip Attach */}
          <button title="Attach file" className="p-1.5 hover:bg-near-black/5 rounded-lg transition-colors cursor-pointer">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          {/* Mic */}
          <button title="Dictate prompt" className="p-1.5 hover:bg-near-black/5 rounded-lg transition-colors cursor-pointer">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="23"></line>
              <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg>
          </button>
        </div>

        {/* Text Input */}
        <input
          type="text"
          placeholder="Ask Caye anything…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSend() }}
          disabled={typing}
          className="flex-1 px-3 py-2 text-[14.5px] text-near-black bg-transparent outline-none border-none placeholder-near-black/30 min-w-0"
        />

        {/* Send Button */}
        <div className="flex items-center gap-2 pr-1">
          <button
            onClick={() => onSend()}
            disabled={!input.trim() || typing}
            className="w-8 h-8 rounded-xl bg-[#0FB5A1] hover:bg-[#0D9C8B] disabled:opacity-45 disabled:hover:bg-[#0FB5A1] text-white flex items-center justify-center transition-all shadow-sm flex-shrink-0 cursor-pointer"
            aria-label="Send prompt"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col tc-canvas min-h-0 font-sans selection:bg-[#0FB5A1] selection:text-white relative">
      {/* Living "Caye is on" aura — only on the empty state. Once a
          conversation begins it's gone, leaving a clean white reading column. */}
      {isEmpty && <div className="caye-stage" aria-hidden="true" />}

      {!panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          className="absolute top-6 right-6 z-20 p-2.5 rounded-xl bg-white/80 hover:bg-white border border-near-black/10 hover:border-near-black/20 text-near-black/60 hover:text-near-black shadow-sm transition-all hover:scale-[1.03] active:scale-[0.98] cursor-pointer flex items-center justify-center"
          title="Show panel (⌘J)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M15 3v18" />
          </svg>
        </button>
      )}
      {/* Scrollable Main Column / Fixed Column Layout */}
      {isEmpty ? (
        /* Empty State */
        <div className="flex-1 overflow-y-auto px-6 py-12 md:py-20 flex justify-center min-h-0 relative z-10">
          <div className="w-full max-w-[720px] flex flex-col justify-center space-y-6 my-auto pb-8">
            <div className="space-y-3 text-center md:text-left">
              <h1 className="text-[44px] md:text-[52px] font-normal tracking-tight text-near-black font-serif italic text-center md:text-left">
                {getGreeting(getFirstName(userName))}
              </h1>
              <p className="text-[14px] text-near-black/55 font-sans not-italic text-center md:text-left truncate">
                {contextText}
              </p>
            </div>

            <WhatsAppStatusBanner />
            <SetupChecklist />

            {renderInputBox()}

            {/* Suggestion chips in vertical stack below input */}
            <div className="flex flex-col gap-2 w-full">
              {suggestions.map((s, idx) => {
                const isCatchUp = s.toLowerCase().startsWith('catch me up')
                return (
                  <SuggestionChip
                    key={idx}
                    prompt={s}
                    onClick={() => (isCatchUp ? onCatchUp() : onSend(s))}
                  />
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Active Conversation History */
        <div className="flex-1 flex flex-col min-h-0 relative items-center justify-center z-10">
          {/* Scrollable Message List */}
          <div className="w-full flex-1 overflow-y-auto px-6 pt-12 md:pt-20 flex justify-center min-h-0">
            <div className="w-full max-w-[700px] flex flex-col space-y-7">
              {messages.map((m, idx) => {
                if (m.from === 'caye') {
                  return (
                    <div key={idx} className="flex items-start gap-4 w-full">
                      <div className="w-12 h-12 rounded-xl bg-near-black flex items-center justify-center text-white flex-shrink-0 mt-1">
                        <CayeMark size={26} />
                      </div>
                      <div className="flex-1 min-w-0 pt-0.5">
                        <div className="caye-prose font-newsreader text-[16.5px] text-near-black/80">
                          {parseCayeMessageText(m.text)}
                        </div>
                        {m.cards && m.cards.length > 0 && (
                          <RichReply cards={m.cards} />
                        )}
                      </div>
                    </div>
                  )
                } else {
                  return (
                    <div key={idx} className="flex items-start justify-end w-full group">
                      <div className="flex flex-col items-end max-w-[80%]">
                        <div className="px-4 py-2.5 rounded-2xl bg-near-black/[0.04] text-near-black border-none font-newsreader text-[16px] leading-[1.65] shadow-sm rounded-tr-none">
                          {m.text}
                        </div>
                        <span className="text-[10px] text-near-black/45 mt-1 font-mono opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                          {new Date(m.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                    </div>
                  )
                }
              })}

              {/* Typing Indicator */}
              {typing && (
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-near-black flex items-center justify-center text-white flex-shrink-0 mt-1">
                    <CayeMark size={26} />
                  </div>
                  <div className="flex-1 min-w-0 flex items-center">
                    <div className="px-1 py-3 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-near-black/35 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-near-black/35 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-near-black/35 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
              {/* Bottom spacer to prevent text from being blocked by the absolute-positioned input bar and gradient blur */}
              <div style={{ height: '80px', flexShrink: 0 }} />
            </div>
          </div>

          {/* Chat Input anchored at bottom with gradient background fade */}
          <div 
            className="absolute bottom-0 left-0 right-0 pt-8 pb-8 px-6 z-10 flex justify-center pointer-events-none"
            style={{
              background: 'linear-gradient(to top, #ffffff 50%, rgba(255, 255, 255, 0) 100%)'
            }}
          >
            <div className="w-full max-w-[720px] pointer-events-auto">
              {renderInputBox()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
