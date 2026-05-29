'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Avatar from '@/components/ui/Avatar'
import ChannelIcon from '@/components/ui/ChannelIcon'
import { CayeMark } from '@/components/brand/CayeMark'
import WhatsAppPingIndicator from './WhatsAppPingIndicator'
import {
  getConnectedAccounts,
  getUnifiedConversations,
  getUnifiedMessages,
  sendUnifiedMessage,
  saveInternalNote,
  updateUnifiedConversation,
  subscribeToUnifiedMessages,
  subscribeToUnifiedConversations,
} from '@/lib/unified-inbox'
import { generateId } from '@/lib/utils'
import { useDashboard } from '@/lib/dashboard-context'
import type {
  ConversationWithAccount,
  UnifiedMessage,
  UnifiedConversation,
} from '@/types/unified-inbox'
import type { ChannelType } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'
import { toast } from 'sonner'
import BookingModal, { type BookingModalData } from '../calendar/BookingModal'
import type { Contact } from '@/types/database'
import ContactDetailPanel from '../contacts/ContactDetailPanel'

// DB channel_type → UI ChannelType
function toUiChannel(ch: string): ChannelType {
  if (ch === 'whatsapp') return 'wa'
  if (ch === 'instagram') return 'ig'
  if (ch === 'messenger') return 'fb'
  if (ch === 'email') return 'em'
  return 'wa'
}

function channelLabel(ch: ChannelType): string {
  if (ch === 'wa') return 'WhatsApp'
  if (ch === 'ig') return 'Instagram'
  if (ch === 'fb') return 'Messenger'
  return 'Email'
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000)
  if (diffDays === 0) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type Filter = 'all' | 'unread' | 'caye-held'

function ConversationRow({
  conv,
  active,
  onClick,
}: {
  conv: ConversationWithAccount
  active: boolean
  onClick: () => void
}) {
  const name = conv.customer_name || 'Unknown'
  const ch = toUiChannel(conv.channel_type)

  return (
    <button
      className={'conv-row' + (active ? ' active' : '')}
      onClick={onClick}
    >
      <div className="conv-av-wrap">
        <Avatar name={name} size={40} />
        <span className="conv-channel">
          <ChannelIcon ch={ch} size={16} />
        </span>
      </div>
      <div className="conv-body">
        <div className="conv-line1">
          <span className="conv-name">{name}</span>
          <span className="conv-time">{formatTime(conv.last_message_at)}</span>
        </div>
        <div className="conv-line2">
          <span className="conv-preview">{conv.last_message_preview || ''}</span>
          {conv.unread_count > 0 && (
            <span className="conv-unread">{conv.unread_count}</span>
          )}
        </div>
        {conv.human_agent_enabled ? (
          <div className="conv-caye held">
            <span className="caye-pip" />
            <span>Caye held</span>
          </div>
        ) : conv.last_sender_type === 'business' ? (
          conv.last_business_sender_kind === 'human' ? (
            <div className="conv-caye replied by-human">
              <span className="caye-pip" />
              <span>You replied</span>
            </div>
          ) : (
            <div className="conv-caye replied by-caye">
              <span className="caye-pip" />
              <span>Caye replied</span>
            </div>
          )
        ) : null}
      </div>
    </button>
  )
}

export default function ChatsScreen({ openCaye, inPanel = false }: { openCaye: () => void; inPanel?: boolean }) {
  const { setPanelScreen, pendingContactChannelId, setPendingContactChannelId, isPanelDetail, setIsPanelDetail } = useDashboard()
  const { workspaceId } = useWorkspace()

  const [conversations, setConversations] = useState<ConversationWithAccount[]>([])
  const [selectedConv, setSelectedConv] = useState<ConversationWithAccount | null>(null)
  const [messages, setMessages] = useState<UnifiedMessage[]>([])

  const [bookingModalOpen, setBookingModalOpen] = useState(false)
  const [bookingInitialData, setBookingInitialData] = useState<BookingModalData | null>(null)
  const [contactPanelOpen, setContactPanelOpen] = useState(false)
  const [contactForPanel, setContactForPanel] = useState<Contact | null>(null)
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [replyText, setReplyText] = useState('')
  const [replyMode, setReplyMode] = useState<'reply' | 'note'>('reply')
  const [composerIsCayeDraft, setComposerIsCayeDraft] = useState(false)
  const [sending, setSending] = useState(false)
  const [togglingAutoReply, setTogglingAutoReply] = useState(false)
  const [accountIds, setAccountIds] = useState<string[]>([])

  const mountedRef = useRef(true)
  const selectedRef = useRef(selectedConv)
  const fetchConvsRef = useRef<() => void>(() => {})
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const prefilledForConvRef = useRef<string | null>(null)

  // Latest Caye-drafted reply on the currently selected held conversation, if any.
  // Reads metadata.proposed_reply off the most recent Caye internal note.
  const latestCayeDraft = (() => {
    if (!selectedConv?.human_agent_enabled) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m.is_internal) continue
      const meta = (m.metadata || {}) as Record<string, unknown>
      if (meta.generated_by !== 'caye') continue
      const draft = meta.proposed_reply
      if (typeof draft === 'string' && draft.trim()) return draft
      return null
    }
    return null
  })()

  // Pre-fill the composer with Caye's proposed reply once when entering a held
  // thread that has one. We use a ref so subsequent edits/clears by the operator
  // don't get re-overwritten. Switching to a different conversation re-arms.
  useEffect(() => {
    const convId = selectedConv?.id ?? null
    if (prefilledForConvRef.current === convId) return
    if (!convId) {
      prefilledForConvRef.current = null
      return
    }
    if (latestCayeDraft && !replyText) {
      setReplyText(latestCayeDraft)
      setComposerIsCayeDraft(true)
      prefilledForConvRef.current = convId
    } else if (latestCayeDraft !== null) {
      // Draft exists but composer not empty (or we already prefilled this conv) — still mark as armed.
      prefilledForConvRef.current = convId
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConv?.id, latestCayeDraft])

  // Clear the "Caye's draft" badge once the operator edits the prefilled text.
  useEffect(() => {
    if (composerIsCayeDraft && latestCayeDraft !== null && replyText !== latestCayeDraft) {
      setComposerIsCayeDraft(false)
    }
  }, [replyText, latestCayeDraft, composerIsCayeDraft])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (inPanel && !isPanelDetail) {
      setSelectedConv(null)
      setContactPanelOpen(false)
    }
  }, [isPanelDetail, inPanel])

  useEffect(() => {
    selectedRef.current = selectedConv
  }, [selectedConv])

  // Scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Fetch connected account IDs once (needed for realtime subscriptions)
  useEffect(() => {
    let ignore = false
    getConnectedAccounts().then(({ data }) => {
      if (!ignore) setAccountIds(data.map((a) => a.id))
    })
    return () => { ignore = true }
  }, [])

  // Fetch conversations (re-runs when search changes)
  const fetchConversations = useCallback(async () => {
    if (!mountedRef.current) return
    setLoadingConvs(true)
    const { data, error } = await getUnifiedConversations(
      'all',
      searchQuery || undefined,
      50,
      false
    )
    if (!mountedRef.current) return
    if (!error) {
      setConversations(data)
      // Auto-select first if nothing selected (only if not inPanel)
      if (!inPanel && !selectedRef.current && data.length > 0) {
        setSelectedConv(data[0])
      }
    }
    if (mountedRef.current) setLoadingConvs(false)
  }, [searchQuery, inPanel])

  useEffect(() => {
    fetchConvsRef.current = fetchConversations
  }, [fetchConversations])

  useEffect(() => {
    fetchConversations()
  }, [fetchConversations])

  // Auto-select conversation when navigated from contacts page
  useEffect(() => {
    if (!pendingContactChannelId || conversations.length === 0) return
    const conv = conversations.find(c => c.customer_id === pendingContactChannelId)
    if (conv) {
      setSelectedConv(conv)
      setPendingContactChannelId(null)
    }
  }, [pendingContactChannelId, conversations])

  // Load messages + subscribe when conversation selected
  useEffect(() => {
    if (!selectedConv) {
      setMessages([])
      return
    }

    setMessages([])
    let active = true
    const convId = selectedConv.id
    const initialUnreadCount = selectedConv.unread_count

    // 1. Subscribe first so we catch messages that arrive while fetching
    const unsubscribe = subscribeToUnifiedMessages(convId, (msg, eventType) => {
      if (!active) return
      setMessages((prev) => {
        if (eventType === 'INSERT' || eventType === 'UPDATE') {
          const existingIdx = prev.findIndex((m) => m.id === msg.id)
          if (existingIdx >= 0) {
            return prev.map((m, i) => (i === existingIdx ? msg : m))
          }
          // Replace matching optimistic message
          const optimisticIdx = prev.findIndex(
            (m) =>
              m.sender_type === 'business' &&
              m.status === 'sending' &&
              m.content === msg.content &&
              Math.abs(new Date(m.sent_at).getTime() - new Date(msg.sent_at).getTime()) < 30000
          )
          if (optimisticIdx >= 0) {
            return prev.map((m, i) => (i === optimisticIdx ? msg : m))
          }
          const merged = [...prev, msg]
          const byId = new Map(merged.map((m) => [m.id, m]))
          return Array.from(byId.values()).sort(
            (a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime()
          )
        }
        return prev
      })
    })

    // 2. Fetch existing messages
    async function loadMessages() {
      setLoadingMsgs(true)
      const { data, error } = await getUnifiedMessages(convId)
      if (!active) return

      if (!error) {
        setMessages((prev) => {
          const validPrev = prev.filter((m) => m.conversation_id === convId)
          const merged = [...data, ...validPrev]
          const byId = new Map(merged.map((m) => [m.id, m]))
          return Array.from(byId.values()).sort(
            (a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime()
          )
        })
      }

      if (active) setLoadingMsgs(false)

      // Mark as read
      if (active && initialUnreadCount > 0) {
        updateUnifiedConversation(convId, { unread_count: 0 })
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, unread_count: 0 } : c))
        )
      }
    }

    loadMessages()

    return () => {
      active = false
      unsubscribe()
    }
  }, [selectedConv?.id])

  // Real-time conversation list updates
  useEffect(() => {
    if (accountIds.length === 0) return

    const unsubscribe = subscribeToUnifiedConversations(
      accountIds,
      (updatedConv: UnifiedConversation) => {
        const isViewing = selectedRef.current?.id === updatedConv.id

        if (isViewing && updatedConv.unread_count > 0) {
          updatedConv = { ...updatedConv, unread_count: 0 }
          updateUnifiedConversation(updatedConv.id, { unread_count: 0 })
        }

        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === updatedConv.id)
          if (idx === -1) {
            fetchConvsRef.current()
            return prev
          }
          return prev
            .map((c) => (c.id === updatedConv.id ? { ...c, ...updatedConv } : c))
            .sort(
              (a, b) =>
                new Date(b.last_message_at || b.created_at).getTime() -
                new Date(a.last_message_at || a.created_at).getTime()
            )
        })

        setSelectedConv((prev) =>
          !prev || prev.id !== updatedConv.id ? prev : { ...prev, ...updatedConv }
        )
      }
    )

    return unsubscribe
  }, [accountIds])

  // Send message or save internal note
  async function handleSend() {
    if (!selectedConv || !replyText.trim() || sending) return
    const text = replyText.trim()
    setReplyText('')
    setSending(true)

    const isNote = replyMode === 'note'

    const tempMsg: UnifiedMessage = {
      id: generateId(),
      conversation_id: selectedConv.id,
      channel_message_id: null,
      sender_type: 'business',
      content: text,
      message_type: 'text',
      sent_at: new Date().toISOString(),
      delivered_at: null,
      read_at: null,
      failed_at: null,
      status: 'sending',
      error_message: null,
      is_internal: isNote,
      metadata: {},
      created_at: new Date().toISOString(),
    }

    setMessages((prev) => [...prev, tempMsg])

    if (!isNote) {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedConv.id
            ? {
                ...c,
                last_message_at: tempMsg.sent_at,
                last_message_preview: text.slice(0, 100),
                last_sender_type: 'business' as const,
                last_business_sender_kind: 'human' as const,
              }
            : c
        )
      )
      setSelectedConv((prev) =>
        prev
          ? { ...prev, last_sender_type: 'business' as const, last_business_sender_kind: 'human' as const }
          : prev
      )
    }

    if (isNote) {
      const { data, error } = await saveInternalNote(selectedConv.id, text)
      setSending(false)
      if (error || !data) {
        setMessages((prev) =>
          prev.map((m) => (m.id === tempMsg.id ? { ...m, status: 'failed' as const } : m))
        )
      } else {
        setMessages((prev) => prev.map((m) => (m.id === tempMsg.id ? data : m)))
      }
    } else {
      const { data, error } = await sendUnifiedMessage(selectedConv.id, text)
      setSending(false)

      if (!error) {
        updateUnifiedConversation(selectedConv.id, {
          last_sender_type: 'business',
          last_business_sender_kind: 'human',
        })
      }

      if (error) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempMsg.id
              ? { ...m, status: 'failed' as const, error_message: error }
              : m
          )
        )
      } else if (data) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === data.id)) return prev
          return prev.map((m) => (m.id === tempMsg.id ? data : m))
        })
      }
    }
  }

  // Toggle Caye auto-reply (inverts human_agent_enabled)
  async function handleToggleAutoReply() {
    if (!selectedConv || togglingAutoReply) return
    const nextEnabled = !selectedConv.human_agent_enabled
    // human_agent_enabled=true means Caye is HELD (auto-reply OFF)
    // human_agent_enabled=false means Caye is active (auto-reply ON)
    const updates = nextEnabled
      ? { human_agent_enabled: true }
      : { human_agent_enabled: false, human_agent_reason: null as unknown as string, human_agent_marked_at: null as unknown as string }

    // Optimistic update
    const patch = { human_agent_enabled: nextEnabled, human_agent_reason: nextEnabled ? selectedConv.human_agent_reason : null }
    setSelectedConv((prev) => prev ? { ...prev, ...patch } : prev)
    setConversations((prev) => prev.map((c) => c.id === selectedConv.id ? { ...c, ...patch } : c))

    setTogglingAutoReply(true)
    const { error } = await updateUnifiedConversation(selectedConv.id, updates)
    setTogglingAutoReply(false)

    if (error) {
      // Revert on failure
      const revert = { human_agent_enabled: selectedConv.human_agent_enabled, human_agent_reason: selectedConv.human_agent_reason }
      setSelectedConv((prev) => prev ? { ...prev, ...revert } : prev)
      setConversations((prev) => prev.map((c) => c.id === selectedConv.id ? { ...c, ...revert } : c))
    }
  }

  // Filtered conversation list
  const filtered = conversations.filter((c) => {
    if (filter === 'unread') return c.unread_count > 0
    if (filter === 'caye-held') return c.human_agent_enabled
    return true
  })

  const unreadCount = conversations.filter((c) => c.unread_count > 0).length
  const heldCount = conversations.filter((c) => c.human_agent_enabled).length

  const handleViewContact = async () => {
    if (!selectedConv) return
    
    try {
      const supabase = getSupabase()
      const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('channel_id', selectedConv.customer_id)
        .maybeSingle()
      if (data) {
        setContactForPanel(data)
        setContactPanelOpen(true)
      } else {
        toast.error('Could not find contact details for this chat.')
      }
    } catch (err) {
      console.error('Error loading contact:', err)
      toast.error('Failed to load contact details.')
    }
  }

  useEffect(() => {
    if (!contactPanelOpen || !selectedConv) return

    let ignore = false
    async function loadContact() {
      const supabase = getSupabase()
      const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('channel_id', selectedConv!.customer_id)
        .maybeSingle()
      if (!ignore && data) {
        setContactForPanel(data)
      }
    }
    loadContact()
    return () => { ignore = true }
  }, [selectedConv?.id, contactPanelOpen])

  const handleNewBookingClick = async () => {
    if (!selectedConv) return

    let phone = ''
    let email = ''
    try {
      const supabase = getSupabase()
      const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('channel_id', selectedConv.customer_id)
        .maybeSingle()
      if (data) {
        phone = data.phone_number || ''
        email = data.email || ''
      }
    } catch (err) {
      console.error('Error fetching contact for booking:', err)
    }

    setBookingInitialData({
      service_id: null,
      customer_name: selectedConv.customer_name || '',
      customer_phone: phone,
      customer_email: email,
      booking_date: new Date().toISOString().slice(0, 10),
      booking_time: '10:00',
      number_of_people: 1,
      duration_minutes: null,
      status: 'confirmed',
      notes: '',
    })
    setBookingModalOpen(true)
  }

  const selName = selectedConv?.customer_name || 'Unknown'
  const selCh = selectedConv ? toUiChannel(selectedConv.channel_type) : 'wa'

  if (inPanel) {
    return (
      <div className="chats-screen" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {contactPanelOpen && contactForPanel ? (
          <ContactDetailPanel
            contact={contactForPanel}
            workspaceId={workspaceId}
            hideMessageAction={true}
            onClose={() => setContactPanelOpen(false)}
            onContactUpdated={(updated) => {
              setContactForPanel(updated)
            }}
          />
        ) : selectedConv ? (
          <section className="thread-col" style={{ flex: 1, display: 'flex', flexDirection: 'column', border: 'none', height: '100%' }}>
            <header className="thread-head">
              <div className="thread-who">
                <Avatar name={selName} size={42} />
                <div>
                  <div className="thread-name">{selName}</div>
                  <div className="thread-role">
                    <ChannelIcon ch={selCh} size={14} /> {channelLabel(selCh)}
                  </div>
                </div>
              </div>
              <div className="thread-actions">
                <button
                  className={'ai-toggle header' + (togglingAutoReply ? ' toggling' : '')}
                  onClick={handleToggleAutoReply}
                  disabled={togglingAutoReply}
                  title={selectedConv.human_agent_enabled ? 'Caye is paused — click to resume auto-reply' : 'Caye is replying — click to pause'}
                >
                  <span className={'ai-toggle-track' + (!selectedConv.human_agent_enabled ? ' on' : '')}>
                    <span className="ai-toggle-thumb" />
                  </span>
                  Caye auto-reply
                </button>
                <button className="ghost-btn" title="Open contact" onClick={handleViewContact}>View contact</button>
                <button className="ghost-btn" title="Book this guest" onClick={handleNewBookingClick}>+ Booking</button>
                <button className="ghost-btn icon-only" title="More">⋯</button>
              </div>
            </header>

            {selectedConv.human_agent_enabled && (
              <div className="caye-strip held">
                <CayeMark size={14} />
                <span className="caye-strip-text">
                  {selectedConv.human_agent_reason || 'Caye held — needs your attention'}
                </span>
              </div>
            )}
            <WhatsAppPingIndicator
              conversationId={selectedConv.id}
              resolved={!selectedConv.human_agent_enabled}
              resolvedAt={selectedConv.last_message_at}
            />

            <div className="thread-body">
              {loadingMsgs ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
                  Loading messages…
                </div>
              ) : messages.length === 0 ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
                  No messages yet
                </div>
              ) : (
                messages.map((msg) => {
                  if (msg.is_internal) {
                    const noteMeta = (msg.metadata || {}) as Record<string, unknown>
                    const byCaye = noteMeta.generated_by === 'caye'
                    const rawDraft = byCaye ? noteMeta.proposed_reply : null
                    const draftText = typeof rawDraft === 'string' && rawDraft.trim() ? rawDraft : null
                    return (
                      <div key={msg.id} className={'msg-row internal' + (byCaye ? ' caye-note' : '')}>
                        <div className={'note-bubble' + (byCaye ? ' caye' : '')}>
                          <div className="note-header">
                            {byCaye ? <CayeMark size={13} /> : <span className="note-icon">🔒</span>}
                            <span className="note-label">{byCaye ? 'Caye note' : 'Internal note'}</span>
                            <span className="note-time">{formatTime(msg.sent_at)}</span>
                          </div>
                          <div className="note-body" style={{ whiteSpace: 'pre-wrap' }}>{msg.content || ''}</div>
                          {draftText && (
                            <div style={{
                              marginTop: 10,
                              paddingLeft: 10,
                              borderLeft: '2px solid var(--tc-caribbean-teal, #0FB5A1)',
                            }}>
                              <div style={{
                                fontSize: 10.5,
                                letterSpacing: '.06em',
                                textTransform: 'uppercase',
                                fontWeight: 600,
                                marginBottom: 4,
                                opacity: 0.6,
                                color: 'var(--tc-near-black)',
                              }}>
                                Proposed reply
                              </div>
                              <div style={{
                                whiteSpace: 'pre-wrap',
                                fontSize: 13,
                                lineHeight: 1.5,
                                fontWeight: 400,
                                color: 'var(--tc-ink-mute, #4a5757)',
                              }}>
                                {draftText}
                              </div>
                              <button
                                onClick={() => {
                                  if (!replyText.trim()) {
                                    setReplyText(draftText)
                                    setComposerIsCayeDraft(true)
                                  }
                                }}
                                disabled={!!replyText.trim()}
                                title={replyText.trim() ? 'Clear the composer first' : 'Copy this draft into the composer'}
                                style={{
                                  marginTop: 8,
                                  fontSize: 11.5,
                                  background: 'transparent',
                                  border: '1px solid rgba(14,26,26,0.12)',
                                  borderRadius: 6,
                                  padding: '3px 8px',
                                  cursor: replyText.trim() ? 'default' : 'pointer',
                                  color: 'var(--tc-near-black)',
                                  opacity: replyText.trim() ? 0.5 : 1,
                                }}
                              >
                                Use this draft
                              </button>
                            </div>
                          )}
                          {msg.status === 'failed' && (
                            <div className="note-error">Failed to save</div>
                          )}
                        </div>
                      </div>
                    )
                  }

                  const side = msg.sender_type === 'customer' ? 'in' : 'out'
                  const isEmail = selectedConv?.channel_type === 'email'
                  const meta = (msg.metadata || {}) as Record<string, string>
                  const emailSubject = isEmail && meta.subject ? meta.subject : null
                  const isByCaye = side === 'out' && (msg.metadata as Record<string, unknown>)?.generated_by === 'caye'
                  return (
                    <div key={msg.id} className={'msg-row ' + side}>
                      {side === 'in' && <Avatar name={selName} size={28} />}
                      <div className="msg-stack">
                        {emailSubject && (
                          <div style={{
                            fontSize: 10.5,
                            fontWeight: 600,
                            color: 'var(--tc-ink-mute)',
                            letterSpacing: '.04em',
                            textTransform: 'uppercase',
                            marginBottom: 3,
                            paddingLeft: side === 'in' ? 2 : 0,
                            textAlign: side === 'out' ? 'right' : 'left',
                          }}>
                            {emailSubject}
                          </div>
                        )}
                        <div className={'bubble ' + side + (isByCaye ? ' by-caye' : '')} style={{ whiteSpace: 'pre-wrap' }}>{msg.content || ''}</div>
                        <div className="msg-time">
                          {formatTime(msg.sent_at)}
                          {msg.status === 'sending' && ' · sending…'}
                          {msg.status === 'failed' && (
                            <span
                              style={{ color: 'var(--tc-coral)' }}
                              title={msg.error_message ?? undefined}
                            >
                              {' · failed to send'}
                              {msg.error_message ? ` — ${msg.error_message}` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <footer 
              className={replyMode === 'note' ? 'note-mode' : ''} 
              style={{
                background: '#ffffff',
                border: '1px solid rgba(14, 26, 26, 0.08)',
                borderRadius: '1rem',
                margin: '10px 16px 16px',
                padding: '10px',
                boxShadow: '0 8px 24px -12px rgba(14,26,26,0.12), 0 2px 4px -2px rgba(14,26,26,0.06)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                flexShrink: 0
              }}
            >
              <div className="reply-tabs" style={{ padding: 0 }}>
                <button
                  className={'rt' + (replyMode === 'reply' ? ' on' : '')}
                  onClick={() => setReplyMode('reply')}
                  style={{ padding: '2px 8px 4px', fontSize: 11.5 }}
                >
                  Reply
                </button>
                <button
                  className={'rt' + (replyMode === 'note' ? ' on note' : '')}
                  onClick={() => setReplyMode('note')}
                  style={{ padding: '2px 8px 4px', fontSize: 11.5 }}
                >
                  Internal note
                </button>
              </div>

              {composerIsCayeDraft && replyMode === 'reply' && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 11, fontWeight: 600, letterSpacing: '.04em',
                  color: 'var(--tc-near-black)', opacity: 0.7,
                  marginTop: -2,
                }}>
                  <CayeMark size={11} />
                  Caye&apos;s draft — edit and send
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <textarea
                  placeholder={replyMode === 'note' ? 'Leave a note (only visible to you)…' : `Reply to ${selName.split(' ')[0]}…`}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  style={{
                    flex: 1,
                    minHeight: 36,
                    maxHeight: 120,
                    fontSize: 13,
                    padding: '4px 6px',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    resize: 'none'
                  }}
                />

                <button
                  onClick={handleSend}
                  disabled={!replyText.trim() || sending}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 10,
                    background: '#0FB5A1',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    opacity: !replyText.trim() || sending ? 0.45 : 1,
                    transition: 'all 0.15s',
                    flexShrink: 0
                  }}
                  aria-label="Send reply"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5"></line>
                    <polyline points="5 12 12 5 19 12"></polyline>
                  </svg>
                </button>
              </div>
            </footer>
          </section>
        ) : (
          <aside className="inbox-col" style={{ flex: 1, display: 'flex', flexDirection: 'column', border: 'none', height: '100%' }}>
            <div className="inbox-head">
              <div className="search">
                <span className="ico">⌕</span>
                <input
                  placeholder="Search messages, names…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="seg">
                <button
                  className={filter === 'all' ? 'on' : ''}
                  onClick={() => setFilter('all')}
                >
                  All
                </button>
                <button
                  className={filter === 'unread' ? 'on' : ''}
                  onClick={() => setFilter('unread')}
                >
                  Unread
                  {unreadCount > 0 && <span className="seg-count">{unreadCount}</span>}
                </button>
                <button
                  className={filter === 'caye-held' ? 'on' : ''}
                  onClick={() => setFilter('caye-held')}
                >
                  <span className="caye-dot" /> Caye held
                  {heldCount > 0 && <span className="seg-count">{heldCount}</span>}
                </button>
              </div>
            </div>

            <div className="inbox-list">
              {loadingConvs ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
                  Loading…
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
                  {searchQuery ? 'No results' : 'No conversations yet'}
                </div>
              ) : (
                filtered.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conv={c}
                    active={false}
                    onClick={() => {
                      setSelectedConv(c)
                      if (inPanel) {
                        setIsPanelDetail(true)
                      }
                    }}
                  />
                ))
              )}
            </div>
          </aside>
        )}

        {bookingModalOpen && bookingInitialData && workspaceId && (
          <BookingModal
            workspaceId={workspaceId}
            initial={bookingInitialData}
            mode="new"
            onClose={() => setBookingModalOpen(false)}
            onSaved={() => {
              setBookingModalOpen(false)
              toast.success('Booking created successfully!')
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className={'chats-screen' + (contactPanelOpen && contactForPanel ? ' contact-info-open' : '')}>

      {/* INBOX LIST */}
      <aside className="inbox-col">
        <div className="inbox-head">
          {!inPanel && (
            <div className="inbox-title">
              <h2>Chats</h2>
              <span className="count-pill">{conversations.length}</span>
            </div>
          )}
          <div className="search">
            <span className="ico">⌕</span>
            <input
              placeholder="Search messages, names…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="seg">
            <button
              className={filter === 'all' ? 'on' : ''}
              onClick={() => setFilter('all')}
            >
              All
            </button>
            <button
              className={filter === 'unread' ? 'on' : ''}
              onClick={() => setFilter('unread')}
            >
              Unread
              {unreadCount > 0 && <span className="seg-count">{unreadCount}</span>}
            </button>
            <button
              className={filter === 'caye-held' ? 'on' : ''}
              onClick={() => setFilter('caye-held')}
            >
              <span className="caye-dot" /> Caye held
              {heldCount > 0 && <span className="seg-count">{heldCount}</span>}
            </button>
          </div>
        </div>

        <div className="inbox-list">
          {loadingConvs ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
              {searchQuery ? 'No results' : 'No conversations yet'}
            </div>
          ) : (
            filtered.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === selectedConv?.id}
                onClick={() => setSelectedConv(c)}
              />
            ))
          )}
        </div>
      </aside>

      {/* THREAD PANE */}
      <section className="thread-col">
        {!selectedConv ? (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            color: 'var(--tc-ink-faint)',
            fontSize: 13,
          }}>
            <CayeMark size={28} />
            <span>Select a conversation</span>
          </div>
        ) : (
          <>
            <header className="thread-head">
              <div className="thread-who">
                <Avatar name={selName} size={42} />
                <div>
                  <div className="thread-name">{selName}</div>
                  <div className="thread-role">
                    <ChannelIcon ch={selCh} size={14} /> {channelLabel(selCh)}
                  </div>
                </div>
              </div>
              <div className="thread-actions">
                <button
                  className={'ai-toggle header' + (togglingAutoReply ? ' toggling' : '')}
                  onClick={handleToggleAutoReply}
                  disabled={togglingAutoReply}
                  title={selectedConv.human_agent_enabled ? 'Caye is paused — click to resume auto-reply' : 'Caye is replying — click to pause'}
                >
                  <span className={'ai-toggle-track' + (!selectedConv.human_agent_enabled ? ' on' : '')}>
                    <span className="ai-toggle-thumb" />
                  </span>
                  Caye auto-reply
                </button>
                 <button className="ghost-btn" title="Open contact" onClick={handleViewContact}>View contact</button>
                <button className="ghost-btn" title="Book this guest" onClick={handleNewBookingClick}>+ Booking</button>
                <button className="ghost-btn icon-only" title="More">⋯</button>
              </div>
            </header>

            {selectedConv.human_agent_enabled && (
              <div className="caye-strip held">
                <CayeMark size={14} />
                <span className="caye-strip-text">
                  {selectedConv.human_agent_reason || 'Caye held — needs your attention'}
                </span>
              </div>
            )}
            <WhatsAppPingIndicator
              conversationId={selectedConv.id}
              resolved={!selectedConv.human_agent_enabled}
              resolvedAt={selectedConv.last_message_at}
            />

            <div className="thread-body">
              {loadingMsgs ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
                  Loading messages…
                </div>
              ) : messages.length === 0 ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
                  No messages yet
                </div>
              ) : (
                messages.map((msg) => {
                  if (msg.is_internal) {
                    const noteMeta = (msg.metadata || {}) as Record<string, unknown>
                    const byCaye = noteMeta.generated_by === 'caye'
                    const rawDraft = byCaye ? noteMeta.proposed_reply : null
                    const draftText = typeof rawDraft === 'string' && rawDraft.trim() ? rawDraft : null
                    return (
                      <div key={msg.id} className={'msg-row internal' + (byCaye ? ' caye-note' : '')}>
                        <div className={'note-bubble' + (byCaye ? ' caye' : '')}>
                          <div className="note-header">
                            {byCaye ? <CayeMark size={13} /> : <span className="note-icon">🔒</span>}
                            <span className="note-label">{byCaye ? 'Caye note' : 'Internal note'}</span>
                            <span className="note-time">{formatTime(msg.sent_at)}</span>
                          </div>
                          <div className="note-body" style={{ whiteSpace: 'pre-wrap' }}>{msg.content || ''}</div>
                          {draftText && (
                            <div style={{
                              marginTop: 10,
                              paddingLeft: 10,
                              borderLeft: '2px solid var(--tc-caribbean-teal, #0FB5A1)',
                            }}>
                              <div style={{
                                fontSize: 10.5,
                                letterSpacing: '.06em',
                                textTransform: 'uppercase',
                                fontWeight: 600,
                                marginBottom: 4,
                                opacity: 0.6,
                                color: 'var(--tc-near-black)',
                              }}>
                                Proposed reply
                              </div>
                              <div style={{
                                whiteSpace: 'pre-wrap',
                                fontSize: 13,
                                lineHeight: 1.5,
                                fontWeight: 400,
                                color: 'var(--tc-ink-mute, #4a5757)',
                              }}>
                                {draftText}
                              </div>
                              <button
                                onClick={() => {
                                  if (!replyText.trim()) {
                                    setReplyText(draftText)
                                    setComposerIsCayeDraft(true)
                                  }
                                }}
                                disabled={!!replyText.trim()}
                                title={replyText.trim() ? 'Clear the composer first' : 'Copy this draft into the composer'}
                                style={{
                                  marginTop: 8,
                                  fontSize: 11.5,
                                  background: 'transparent',
                                  border: '1px solid rgba(14,26,26,0.12)',
                                  borderRadius: 6,
                                  padding: '3px 8px',
                                  cursor: replyText.trim() ? 'default' : 'pointer',
                                  color: 'var(--tc-near-black)',
                                  opacity: replyText.trim() ? 0.5 : 1,
                                }}
                              >
                                Use this draft
                              </button>
                            </div>
                          )}
                          {msg.status === 'failed' && (
                            <div className="note-error">Failed to save</div>
                          )}
                        </div>
                      </div>
                    )
                  }

                  const side = msg.sender_type === 'customer' ? 'in' : 'out'
                  const isEmail = selectedConv?.channel_type === 'email'
                  const meta = (msg.metadata || {}) as Record<string, string>
                  const emailSubject = isEmail && meta.subject ? meta.subject : null
                  const isByCaye = side === 'out' && (msg.metadata as Record<string, unknown>)?.generated_by === 'caye'
                  return (
                    <div key={msg.id} className={'msg-row ' + side}>
                      {side === 'in' && <Avatar name={selName} size={28} />}
                      <div className="msg-stack">
                        {emailSubject && (
                          <div style={{
                            fontSize: 10.5,
                            fontWeight: 600,
                            color: 'var(--tc-ink-mute)',
                            letterSpacing: '.04em',
                            textTransform: 'uppercase',
                            marginBottom: 3,
                            paddingLeft: side === 'in' ? 2 : 0,
                            textAlign: side === 'out' ? 'right' : 'left',
                          }}>
                            {emailSubject}
                          </div>
                        )}
                        <div className={'bubble ' + side + (isByCaye ? ' by-caye' : '')} style={{ whiteSpace: 'pre-wrap' }}>{msg.content || ''}</div>
                        <div className="msg-time">
                          {formatTime(msg.sent_at)}
                          {msg.status === 'sending' && ' · sending…'}
                          {msg.status === 'failed' && (
                            <span
                              style={{ color: 'var(--tc-coral)' }}
                              title={msg.error_message ?? undefined}
                            >
                              {' · failed to send'}
                              {msg.error_message ? ` — ${msg.error_message}` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <footer className={'reply-box' + (replyMode === 'note' ? ' note-mode' : '')}>
              <div className="reply-tabs">
                <button
                  className={'rt' + (replyMode === 'reply' ? ' on' : '')}
                  onClick={() => setReplyMode('reply')}
                >
                  Reply
                </button>
                <button
                  className={'rt' + (replyMode === 'note' ? ' on note' : '')}
                  onClick={() => setReplyMode('note')}
                >
                  Internal note
                </button>
              </div>
              {composerIsCayeDraft && replyMode === 'reply' && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 11, fontWeight: 600, letterSpacing: '.04em',
                  color: 'var(--tc-near-black)', opacity: 0.7,
                  margin: '4px 2px 0',
                }}>
                  <CayeMark size={11} />
                  Caye&apos;s draft — edit and send
                </div>
              )}
              <textarea
                placeholder={replyMode === 'note' ? 'Leave a note (only visible to you)…' : `Write back to ${selName.split(' ')[0]}…`}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend()
                }}
              />
              <div className="reply-footer">
                <div className="reply-tools">
                  <button title="Attach" aria-label="Attach">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.5 4 5.8 8.7a2.4 2.4 0 1 0 3.4 3.4l5-5a4 4 0 1 0-5.7-5.6L3.4 6.6" />
                    </svg>
                  </button>
                  <button title="Template" aria-label="Template">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
                      <path d="M2.5 6.5h11M5.5 9.5h5M5.5 11h3" />
                    </svg>
                  </button>
                  <button
                    className="caye-btn icon-only"
                    title="Ask Caye"
                    aria-label="Ask Caye"
                    onClick={openCaye}
                  >
                    <CayeMark size={14} />
                  </button>
                </div>
                <button
                  className={'btn-send' + (replyMode === 'note' ? ' note' : '')}
                  onClick={handleSend}
                  disabled={!replyText.trim() || sending}
                >
                  {sending ? (replyMode === 'note' ? 'Saving…' : 'Sending…') : (replyMode === 'note' ? 'Save note' : 'Send')}
                </button>
              </div>
            </footer>
          </>
        )}
       </section>

      {contactPanelOpen && contactForPanel && (
        <ContactDetailPanel
          contact={contactForPanel}
          workspaceId={workspaceId}
          hideMessageAction={true}
          onClose={() => setContactPanelOpen(false)}
          onContactUpdated={(updated) => {
            setContactForPanel(updated)
          }}
        />
      )}

      {bookingModalOpen && bookingInitialData && workspaceId && (
        <BookingModal
          workspaceId={workspaceId}
          initial={bookingInitialData}
          mode="new"
          onClose={() => setBookingModalOpen(false)}
          onSaved={() => {
            setBookingModalOpen(false)
            toast.success('Booking created successfully!')
          }}
        />
      )}
    </div>
  )
}
