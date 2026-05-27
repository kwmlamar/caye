'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'
import SuggestionChip from '../SuggestionChip'
import SetupChecklist from '../SetupChecklist'
import { RichReply, type CardPayload } from './RichReply'
import { useDashboard } from '@/lib/dashboard-context'

interface Message {
  from: 'user' | 'caye'
  text: string
  timestamp: string
  cards?: CardPayload[]
}

function getGreeting(name?: string) {
  const h = new Date().getHours()
  const first = name?.split(' ')[0]
  if (h < 12) return first ? `Morning, ${first}.` : 'Morning.'
  if (h < 18) return first ? `Afternoon, ${first}.` : 'Afternoon.'
  return first ? `Evening, ${first}.` : 'Evening.'
}

function parseCayeMessageText(text: string) {
  const parseBold = (str: string): React.ReactNode[] => {
    const parts = str.split('**')
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        return <strong key={i} className="font-semibold text-near-black">{part}</strong>
      }
      return part
    })
  }

  const blocks = text.split('\n\n')

  return blocks.map((block, blockIdx) => {
    const lines = block.split('\n')
    const isList = lines.length > 0 && lines.every(line => {
      const t = line.trim()
      return t.startsWith('-') || t.startsWith('•')
    })
    
    if (isList) {
      return (
        <ul key={blockIdx} className="space-y-2 mb-4 list-disc list-outside ml-5 marker:text-near-black/40">
          {lines.map((line, lineIdx) => {
            const cleanLine = line.replace(/^\s*[-•]\s*/, '')
            return (
              <li key={lineIdx} className="text-[15px] leading-[1.7] text-near-black/85 font-sans">
                {parseBold(cleanLine)}
              </li>
            )
          })}
        </ul>
      )
    }

    let currentList: React.ReactNode[] = []
    const elements: React.ReactNode[] = []

    lines.forEach((line, lineIdx) => {
      const trimmed = line.trim()
      const isListItem = trimmed.startsWith('-') || trimmed.startsWith('•')

      if (isListItem) {
        const cleanLine = line.replace(/^\s*[-•]\s*/, '')
        currentList.push(
          <li key={lineIdx} className="text-[15px] leading-[1.7] text-near-black/85 font-sans">
            {parseBold(cleanLine)}
          </li>
        )
      } else {
        if (currentList.length > 0) {
          elements.push(
            <ul key={`list-${lineIdx}`} className="space-y-2 mb-4 list-disc list-outside ml-5 marker:text-near-black/40">
              {currentList}
            </ul>
          )
          currentList = []
        }
        if (trimmed) {
          elements.push(
            <p key={lineIdx} className="mb-4 text-[15px] leading-[1.7] text-near-black/85 font-sans">
              {parseBold(line)}
            </p>
          )
        }
      }
    })

    if (currentList.length > 0) {
      elements.push(
        <ul key={`list-end`} className="space-y-2 mb-4 list-disc list-outside ml-5 marker:text-near-black/40">
          {currentList}
        </ul>
      )
    }

    return <React.Fragment key={blockIdx}>{elements}</React.Fragment>
  })
}

export default function HomeScreen() {
  const { workspaceId, workspace } = useWorkspace()
  const { setPanelScreen, setPanelOpen, panelOpen } = useDashboard()
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [contextText, setContextText] = useState('Caye is running. Ask her anything.')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const discoveryPolledRef = useRef(false)

  // Fetch real workspace context for the tagline
  useEffect(() => {
    if (!workspaceId) return
    async function loadContext() {
      try {
        const supabase = getSupabase()
        
        // 1. Get Caye held count
        const { count: heldCount } = await supabase
          .from('unified_conversations')
          .select('id', { count: 'exact', head: true })
          .eq('human_agent_enabled', true)
          .eq('is_archived', false)

        // 2. Get bookings created in last 24h
        const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const { count: bookingsCount } = await supabase
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', workspaceId)
          .eq('status', 'confirmed')
          .gte('created_at', yesterdayIso)

        if (heldCount && heldCount > 0) {
          setContextText(`${heldCount} ${heldCount === 1 ? 'message is' : 'messages are'} waiting on your call.`)
        } else if (bookingsCount && bookingsCount > 0) {
          setContextText(`${bookingsCount} new booking${bookingsCount === 1 ? '' : 's'} since you last checked.`)
        } else {
          setContextText('Inbox is clear. Caye is running. Ask her anything.')
        }
      } catch (err) {
        console.error('Failed to load greeting context:', err)
        setContextText('Caye is running. Ask her anything.')
      }
    }
    loadContext()
  }, [workspaceId])

  // Load threads/active thread from local storage
  const loadActiveThread = useCallback(() => {
    if (!workspaceId) return
    const activeId = localStorage.getItem(`caye_active_thread_id_${workspaceId}`)
    if (activeId) {
      setActiveThreadId(activeId)
      const storedHistory = localStorage.getItem(`caye_messages_${workspaceId}_${activeId}`)
      if (storedHistory) {
        try {
          const parsed = JSON.parse(storedHistory) as Message[]
          // Filter out default Caye welcome message from old runs
          const filtered = parsed.filter(m => {
            if (m.from === 'caye') {
              const textLower = m.text.toLowerCase()
              if (
                textLower.includes('receptionist') ||
                textLower.includes('caribbean') ||
                textLower.includes('ask me anything about your bookings')
              ) {
                return false
              }
            }
            return true
          })
          setMessages(filtered)
        } catch (e) {
          setMessages([])
        }
      } else {
        // Start completely empty
        setMessages([])
      }
    } else {
      localStorage.setItem(`caye_active_thread_id_${workspaceId}`, 't-1')
      setActiveThreadId('t-1')
      setMessages([])
    }
  }, [workspaceId])

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

        // Insert as Caye's first message
        const cayeMsg: Message = {
          from: 'caye',
          text: greeting,
          timestamp: new Date().toISOString(),
        }

        const threadKey = localStorage.getItem(`caye_active_thread_id_${workspaceId}`) || 't-1'
        const existingRaw = localStorage.getItem(`caye_messages_${workspaceId}_${threadKey}`)
        const existing: Message[] = existingRaw ? JSON.parse(existingRaw) : []

        // Only prepend if the thread is empty (no prior messages)
        if (existing.length === 0) {
          const withGreeting = [cayeMsg]
          localStorage.setItem(`caye_messages_${workspaceId}_${threadKey}`, JSON.stringify(withGreeting))
          setMessages(withGreeting)
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
      const threadId = (e as CustomEvent).detail
      setActiveThreadId(threadId)
      loadActiveThread()
    }
    window.addEventListener('caye-thread-selected', handleSelected)
    return () => window.removeEventListener('caye-thread-selected', handleSelected)
  }, [loadActiveThread])

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

    // Save history to localStorage
    if (activeThreadId) {
      localStorage.setItem(`caye_messages_${workspaceId}_${activeThreadId}`, JSON.stringify(updatedMessages))
      // Update thread title based on the first user message if it was empty/default
      const threadsStored = localStorage.getItem(`caye_threads_${workspaceId}`)
      if (threadsStored) {
        const threads = JSON.parse(threadsStored)
        const threadIndex = threads.findIndex((t: any) => t.id === activeThreadId)
        if (threadIndex !== -1 && (threads[threadIndex].title === 'New conversation' || threads[threadIndex].title === 'What bookings came in overnight?')) {
          threads[threadIndex].title = text.length > 28 ? text.slice(0, 28) + '...' : text
          threads[threadIndex].updated_at = new Date().toISOString()
          localStorage.setItem(`caye_threads_${workspaceId}`, JSON.stringify(threads))
          window.dispatchEvent(new CustomEvent('caye-threads-updated'))
        }
      }
    }

    try {
      const client = getSupabase()
      const { data: { session } } = await client.auth.getSession()
      const token = session?.access_token || ''

      const historyPayload = messages.map(m => ({
        from: m.from,
        text: m.text,
      }))

      const res = await fetch('/api/caye/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text, workspaceId, history: historyPayload }),
      })

      const data = await res.json()
      const replyText = data.reply || "I couldn't reach the server. Let's try again in a bit."

      const cayeMsg: Message = {
        from: 'caye',
        text: replyText,
        timestamp: new Date().toISOString(),
        cards: data.cards || undefined,
      }

      const finalMessages = [...updatedMessages, cayeMsg]
      setMessages(finalMessages)
      if (activeThreadId) {
        localStorage.setItem(`caye_messages_${workspaceId}_${activeThreadId}`, JSON.stringify(finalMessages))
      }

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
    "What bookings came in overnight?",
    "Show me anything that needs my call.",
    "Draft a reply to the next pending message.",
  ]

  const isEmpty = messages.length === 0

  const renderInputBox = () => {
    return (
      <div className="relative flex items-center bg-white rounded-2xl border border-[rgba(14,26,26,0.08)] focus-within:border-[rgba(14,26,26,0.18)] shadow-[0_8px_24px_-12px_rgba(14,26,26,0.12),0_2px_4px_-2px_rgba(14,26,26,0.06)] p-3 transition-colors">
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
      {/* Scrollable Main Column */}
      <div className="flex-1 overflow-y-auto px-6 py-12 md:py-20 flex justify-center">
        <div className="w-full max-w-[720px] flex flex-col" style={{ minHeight: '100%' }}>
          
          {isEmpty ? (
            /* Empty State */
            <div className="flex-1 flex flex-col justify-center space-y-6 my-auto pb-8">
              <div className="space-y-3 text-center md:text-left">
                <h1 className="text-[44px] md:text-[52px] font-normal tracking-tight text-near-black font-serif italic text-center md:text-left">
                  {getGreeting(workspace?.full_name || undefined)}
                </h1>
                <p className="text-[14px] text-near-black/55 font-sans not-italic text-center md:text-left truncate">
                  {contextText}
                </p>
              </div>

              <SetupChecklist />

              {/* Chat input inside the empty stack */}
              {renderInputBox()}

              {/* Three suggestion chips in vertical stack below input */}
              <div className="flex flex-col gap-2 w-full">
                {suggestions.map((s, idx) => (
                  <SuggestionChip key={idx} prompt={s} onClick={() => onSend(s)} />
                ))}
              </div>
            </div>
          ) : (
            /* Active Conversation History */
            <div className="flex-1 flex flex-col justify-between" style={{ minHeight: '100%' }}>
              <div className="flex-1 space-y-6 pb-6">
                {messages.map((m, idx) => {
                  if (m.from === 'caye') {
                    return (
                      <div key={idx} className="flex items-start gap-4 w-full">
                        <div className="w-8 h-8 rounded-lg bg-near-black flex items-center justify-center text-white flex-shrink-0 mt-1">
                          <CayeMark size={14} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[15px] leading-[1.7] text-near-black/85 font-sans">
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
                          <div className="px-4 py-2.5 rounded-2xl bg-near-black/[0.04] text-near-black border-none text-[14.5px] leading-relaxed shadow-sm rounded-tr-none">
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
                    <div className="w-8 h-8 rounded-lg bg-near-black flex items-center justify-center text-white flex-shrink-0 mt-1">
                      <CayeMark size={14} />
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
              </div>

              {/* Chat Input anchored at bottom in active view */}
              <div className="space-y-4 pt-6 border-t border-near-black/5 mt-auto flex-shrink-0">
                {renderInputBox()}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
