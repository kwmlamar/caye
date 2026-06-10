'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

interface SetupStatus {
  operatorWhatsappVerified: boolean
  whatsappConnected: boolean
  zohoConnected: boolean
  voiceAlignmentConfirmed: boolean
}

type ChannelKey = 'wa-personal' | 'channel' | 'align'

interface ChannelItem {
  key: ChannelKey
  label: string
  sublabel: string
  done: boolean
  onClick: () => void
}

// ─── Channel icon tile ───────────────────────────────────────────────────────
// Each line Caye answers gets its own branded tile: WhatsApp green for the
// personal + business numbers, ink for Zoho Mail. A teal check badges the
// corner once a line is live.
function ChannelTile({ channel, done }: { channel: ChannelKey; done: boolean }) {
  const tile: Record<ChannelKey, { bg: string; icon: React.ReactNode }> = {
    'wa-personal': {
      bg: 'bg-gradient-to-br from-[#2bd573] to-[#1fae57]',
      icon: <WhatsAppGlyph />,
    },
    channel: {
      bg: 'bg-near-black',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-[17px] h-[17px]">
          <path d="M4 7h11" />
          <path d="M4 12h16" />
          <path d="M4 17h7" />
          <circle cx="19" cy="7" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    align: {
      bg: 'bg-gradient-to-br from-[#0FB5A1] to-[#0a8475]',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-[17px] h-[17px]">
          <path d="M12 3v3" />
          <path d="M12 18v3" />
          <path d="M5 12H2" />
          <path d="M22 12h-3" />
          <path d="m5.6 5.6 2.1 2.1" />
          <path d="m16.3 16.3 2.1 2.1" />
          <path d="m5.6 18.4 2.1-2.1" />
          <path d="m16.3 7.7 2.1-2.1" />
        </svg>
      ),
    },
  }

  return (
    <div className="relative flex-shrink-0">
      <div className={`w-9 h-9 rounded-[11px] flex items-center justify-center text-white shadow-sm ${tile[channel].bg}`}>
        {tile[channel].icon}
      </div>
      {done && (
        <span className="absolute -bottom-1 -right-1 w-[15px] h-[15px] rounded-full bg-[#0FB5A1] ring-2 ring-white flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="w-[9px] h-[9px]">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      )}
    </div>
  )
}

function WhatsAppGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px]">
      <path d="M17.6 6.32A7.85 7.85 0 0 0 12.05 4a7.94 7.94 0 0 0-6.9 11.9L4 20l4.2-1.1a7.9 7.9 0 0 0 3.8.97h.004a7.94 7.94 0 0 0 5.6-13.55ZM12.05 18.5a6.6 6.6 0 0 1-3.36-.92l-.24-.14-2.5.65.67-2.43-.16-.25a6.6 6.6 0 1 1 5.6 3.09Zm3.6-4.94c-.2-.1-1.17-.58-1.35-.64-.18-.07-.31-.1-.44.1-.13.2-.5.64-.62.77-.11.13-.23.15-.43.05a5.4 5.4 0 0 1-1.6-.99 6 6 0 0 1-1.1-1.37c-.12-.2-.01-.3.09-.4.09-.09.2-.23.3-.35.1-.12.13-.2.2-.34.06-.13.03-.25-.02-.35-.05-.1-.44-1.07-.6-1.46-.16-.38-.32-.33-.44-.34h-.38a.73.73 0 0 0-.53.25 2.23 2.23 0 0 0-.69 1.65c0 .98.71 1.92.81 2.05.1.13 1.4 2.13 3.38 2.99.47.2.84.32 1.13.42.47.15.9.13 1.24.08.38-.06 1.17-.48 1.33-.94.17-.46.17-.85.12-.94-.05-.08-.18-.13-.38-.23Z" />
    </svg>
  )
}

export default function SetupChecklist() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<SetupStatus>({
    operatorWhatsappVerified: false,
    whatsappConnected: false,
    zohoConnected: false,
    voiceAlignmentConfirmed: false,
  })
  const [otpOpen, setOtpOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [alignOpen, setAlignOpen] = useState(false)

  async function refresh() {
    if (!workspaceId) return
    try {
      const supabase = getSupabase()

      const [{ data: accounts }, { data: cfg }, { data: customer }] = await Promise.all([
        supabase
          .from('connected_accounts')
          .select('channel_type, is_active')
          .eq('user_id', workspaceId)
          .eq('is_active', true),
        supabase
          .from('workspace_ai_config')
          .select('operator_whatsapp_verified_at')
          .eq('workspace_id', workspaceId)
          .maybeSingle(),
        supabase
          .from('customers')
          .select('voice_alignment_confirmed_at')
          .eq('id', workspaceId)
          .maybeSingle(),
      ])

      const whatsappConnected = (accounts || []).some((a) => a.channel_type === 'whatsapp')
      const zohoConnected = (accounts || []).some((a) => a.channel_type === 'email')
      const operatorWhatsappVerified = Boolean(cfg?.operator_whatsapp_verified_at)
      const voiceAlignmentConfirmed = Boolean(customer?.voice_alignment_confirmed_at)

      setStatus({
        operatorWhatsappVerified,
        whatsappConnected,
        zohoConnected,
        voiceAlignmentConfirmed,
      })
    } catch (err) {
      console.error('[SetupChecklist] Failed to query setup status:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  if (loading) {
    return (
      <div className="rounded-2xl bg-white border border-[rgba(14,26,26,0.08)] shadow-[0_1px_3px_rgba(14,26,26,0.04),0_12px_32px_-18px_rgba(14,26,26,0.12)] p-6 font-sans">
        <div className="flex items-center gap-2.5 text-near-black/40">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0FB5A1] animate-pulse" />
          <p className="text-[12px] font-mono tracking-[0.04em] animate-pulse">Opening the lines…</p>
        </div>
      </div>
    )
  }

  const channelConnected = status.whatsappConnected || status.zohoConnected
  const allDone =
    status.operatorWhatsappVerified && channelConnected && status.voiceAlignmentConfirmed
  if (allDone) return null

  const items: ChannelItem[] = [
    {
      key: 'wa-personal',
      label: 'Share your WhatsApp with Caye',
      sublabel: 'So she can reach you when a call is yours to make',
      done: status.operatorWhatsappVerified,
      onClick: () => setOtpOpen(true),
    },
    {
      key: 'channel',
      label: 'Connect a channel',
      sublabel: channelConnected
        ? 'Caye is reading your inbox'
        : 'Email or WhatsApp — pick the line your customers use',
      done: channelConnected,
      onClick: () => setPickerOpen(true),
    },
  ]

  // Card 3 only surfaces once a channel is connected — otherwise there are no
  // samples to extract from and the modal would just error out.
  if (channelConnected) {
    items.push({
      key: 'align',
      label: 'Get aligned with Caye',
      sublabel: status.voiceAlignmentConfirmed
        ? 'Caye writes in your voice'
        : 'She read your last messages — confirm how you sound',
      done: status.voiceAlignmentConfirmed,
      onClick: () => setAlignOpen(true),
    })
  }

  const doneCount = items.filter((i) => i.done).length
  const pct = Math.round((doneCount / items.length) * 100)

  return (
    <>
      <div className="relative overflow-hidden rounded-2xl bg-white border border-[rgba(14,26,26,0.08)] shadow-[0_1px_3px_rgba(14,26,26,0.04),0_14px_36px_-18px_rgba(14,26,26,0.14)] font-sans">
        {/* Hairline teal accent across the top — the line is open */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#0FB5A1]/40 to-transparent" />

        <div className="p-5 md:p-6 space-y-5">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2 min-w-0">
              <div className="flex items-center gap-2">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-[#0FB5A1] opacity-60 animate-ping" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#0FB5A1]" />
                </span>
                <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-near-black/45 font-semibold">
                  Getting set up
                </span>
              </div>
              <h3 className="font-serif italic text-[20px] leading-tight tracking-tight text-near-black">
                Open the lines
              </h3>
              <p className="text-[12.5px] leading-snug text-near-black/50">
                Connect a channel and Caye starts answering. She reads your inbox and figures out the rest.
              </p>
            </div>

            {/* Progress dial */}
            <div className="flex-shrink-0 flex flex-col items-end gap-1.5 pt-0.5">
              <span className="font-mono text-[11px] tracking-[0.04em] text-near-black/40">
                <span className="text-near-black font-semibold">{doneCount}</span>
                <span className="text-near-black/30"> / {items.length}</span>
              </span>
              <div className="h-1 w-16 rounded-full bg-near-black/[0.07] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#0FB5A1] transition-[width] duration-700 ease-out"
                  style={{ width: `${Math.max(pct, 4)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Channel rows */}
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.key}>
                <div className="group flex items-center gap-3.5 rounded-xl px-2.5 py-2.5 -mx-1.5 transition-colors hover:bg-near-black/[0.025]">
                  <ChannelTile channel={item.key} done={item.done} />

                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-[13.5px] leading-tight font-medium transition-colors ${
                        item.done ? 'text-near-black/40' : 'text-near-black'
                      }`}
                    >
                      {item.label}
                    </div>
                    <div className="text-[11.5px] leading-snug text-near-black/45 mt-0.5 truncate">
                      {item.sublabel}
                    </div>
                  </div>

                  {item.done ? (
                    <span className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-full bg-[#0FB5A1]/[0.1] px-2.5 py-1 font-mono text-[9.5px] tracking-[0.12em] uppercase font-semibold text-[#0a8475]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#0FB5A1]" />
                      Live
                    </span>
                  ) : (
                    <button
                      onClick={item.onClick}
                      className="flex-shrink-0 inline-flex items-center gap-1 rounded-lg border border-near-black/[0.14] px-3 py-1.5 text-[12px] font-medium text-near-black/75 hover:text-white hover:bg-near-black hover:border-near-black transition-all cursor-pointer"
                    >
                      Connect
                      <span className="transition-transform group-hover:translate-x-0.5">›</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {otpOpen && (
        <OperatorOtpModal
          onClose={() => setOtpOpen(false)}
          onVerified={() => {
            setOtpOpen(false)
            refresh()
          }}
        />
      )}

      {pickerOpen && (
        <ChannelPickerModal
          workspaceId={workspaceId ?? ''}
          onClose={() => setPickerOpen(false)}
          onPick={(target) => {
            setPickerOpen(false)
            router.push(`/dashboard/${workspaceId}/settings?tab=channels&connect=${target}`)
          }}
        />
      )}

      {alignOpen && workspaceId && (
        <AlignmentModal
          workspaceId={workspaceId}
          onClose={() => setAlignOpen(false)}
          onConfirmed={() => {
            setAlignOpen(false)
            refresh()
          }}
        />
      )}
    </>
  )
}

// ─── OTP modal ─────────────────────────────────────────────────────────────

function OperatorOtpModal({
  onClose,
  onVerified,
}: {
  onClose: () => void
  onVerified: () => void
}) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [stage, setStage] = useState<'enter-phone' | 'enter-code'>('enter-phone')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function authedFetch(url: string, body: Record<string, unknown>) {
    const supabase = getSupabase()
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const token = session?.access_token
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  }

  async function sendCode() {
    setError(null)
    setBusy(true)
    try {
      const res = await authedFetch('/api/caye/operator-otp/send', { phone })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to send code')
      setStage('enter-code')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode() {
    setError(null)
    setBusy(true)
    try {
      const res = await authedFetch('/api/caye/operator-otp/verify', { code })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Verification failed')
      onVerified()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/35 backdrop-blur-[2px]">
      <div className="bg-white text-near-black rounded-2xl p-6 w-[400px] max-w-[90vw] space-y-4 font-sans border border-near-black/10 shadow-[0_24px_60px_-20px_rgba(14,26,26,0.25)]">
        <div>
          <h4 className="text-[15px] font-semibold tracking-tight">
            {stage === 'enter-phone'
              ? 'Share your WhatsApp with Caye'
              : 'Enter the 6-digit code'}
          </h4>
          <p className="text-[12px] text-near-black/55 mt-1 leading-snug">
            {stage === 'enter-phone'
              ? "I'll DM you when something needs your call. One number, your personal WhatsApp."
              : 'Check WhatsApp for a message from Caye.'}
          </p>
        </div>

        {stage === 'enter-phone' ? (
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 242 555 0123"
            className="w-full bg-cream/60 border border-near-black/12 rounded-lg px-3 py-2 text-[14px] text-near-black placeholder-near-black/35 focus:outline-none focus:border-near-black/30 focus:bg-white transition-colors"
          />
        ) : (
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="123456"
            className="w-full bg-cream/60 border border-near-black/12 rounded-lg px-3 py-2 text-[16px] font-mono tracking-[0.5em] text-center text-near-black placeholder-near-black/30 focus:outline-none focus:border-near-black/30 focus:bg-white transition-colors"
          />
        )}

        {error && <p className="text-[12px] text-[#c94824] font-medium">{error}</p>}

        <div className="flex items-center justify-between gap-3 pt-1">
          <button
            onClick={onClose}
            className="text-[12px] text-near-black/55 hover:text-near-black/85 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={stage === 'enter-phone' ? sendCode : verifyCode}
            disabled={busy || (stage === 'enter-phone' ? phone.length < 7 : code.length !== 6)}
            className="bg-[#0FB5A1] hover:bg-[#0FB5A1]/90 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-[12px] font-semibold cursor-pointer shadow-sm transition-all"
          >
            {busy ? '…' : stage === 'enter-phone' ? 'Send code' : 'Verify'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Channel picker modal ──────────────────────────────────────────────────
// Card 2 ("Connect a channel") used to be two separate cards (Zoho + WhatsApp
// Business). The picker collapses them: pick the line your customers use,
// jump to the settings flow that wires it up.

type ChannelTarget = 'zoho' | 'gmail' | 'whatsapp'

function ChannelPickerModal({
  onClose,
  onPick,
}: {
  workspaceId: string
  onClose: () => void
  onPick: (target: ChannelTarget) => void
}) {
  const options: Array<{
    target: ChannelTarget
    label: string
    sublabel: string
    disabled?: boolean
  }> = [
    { target: 'zoho', label: 'Zoho Mail', sublabel: 'Email + calendar' },
    { target: 'whatsapp', label: 'WhatsApp Business', sublabel: 'Customer chat line' },
    { target: 'gmail', label: 'Gmail', sublabel: 'Coming soon', disabled: true },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/35 backdrop-blur-[2px]">
      <div className="bg-white text-near-black rounded-2xl p-6 w-[420px] max-w-[90vw] space-y-4 font-sans border border-near-black/10 shadow-[0_24px_60px_-20px_rgba(14,26,26,0.25)]">
        <div>
          <h4 className="text-[15px] font-semibold tracking-tight">Connect a channel</h4>
          <p className="text-[12px] text-near-black/55 mt-1 leading-snug">
            Pick the line your customers use to reach you. You can add more later.
          </p>
        </div>

        <ul className="space-y-1.5">
          {options.map((opt) => (
            <li key={opt.target}>
              <button
                onClick={() => !opt.disabled && onPick(opt.target)}
                disabled={opt.disabled}
                className="w-full flex items-center justify-between gap-3 rounded-xl border border-near-black/[0.12] px-3.5 py-3 hover:border-near-black/30 hover:bg-near-black/[0.02] disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:border-near-black/[0.12] disabled:hover:bg-transparent transition-colors cursor-pointer text-left"
              >
                <div>
                  <div className="text-[13.5px] font-medium text-near-black">{opt.label}</div>
                  <div className="text-[11.5px] text-near-black/50 mt-0.5">{opt.sublabel}</div>
                </div>
                <span className="text-near-black/30 text-[14px]">›</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-end pt-1">
          <button
            onClick={onClose}
            className="text-[12px] text-near-black/55 hover:text-near-black/85 cursor-pointer transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Alignment modal ───────────────────────────────────────────────────────
// Card 3. Pulls the owner's last 30 sent emails, runs voice extraction
// server-side, shows what Caye picked up. Owner edits and confirms — the
// confirmed profile becomes Caye's reply voice.

interface VoiceProfileShape {
  writing_style: string
  common_phrases: string[]
  greeting_style: string
  signoff_style: string
  formality_level: 'casual' | 'warm-professional' | 'formal'
  tone_notes: string
  signature_block: string | null
  tagline: string | null
  standard_signoff: string | null
  standard_opener: string | null
}

function AlignmentModal({
  workspaceId,
  onClose,
  onConfirmed,
}: {
  workspaceId: string
  onClose: () => void
  onConfirmed: () => void
}) {
  const [stage, setStage] = useState<'loading' | 'review' | 'saving'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<VoiceProfileShape | null>(null)
  const [sampleCount, setSampleCount] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/onboarding/voice-alignment/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        })
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setError(data.message ?? data.error ?? 'Caye couldn\'t read your samples.')
          setStage('review')
          return
        }
        setProfile(data.voiceProfile)
        setSampleCount(data.sample_count ?? 0)
        setStage('review')
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Unexpected error.')
        setStage('review')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  async function confirm() {
    if (!profile) return
    setStage('saving')
    setError(null)
    try {
      const res = await fetch('/api/onboarding/voice-alignment/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, voiceProfile: profile }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      onConfirmed()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage('review')
    }
  }

  function patch<K extends keyof VoiceProfileShape>(key: K, value: VoiceProfileShape[K]) {
    setProfile((p) => (p ? { ...p, [key]: value } : p))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/35 backdrop-blur-[2px] p-4">
      <div className="bg-white text-near-black rounded-2xl w-[560px] max-w-[95vw] max-h-[90vh] flex flex-col font-sans border border-near-black/10 shadow-[0_24px_60px_-20px_rgba(14,26,26,0.25)]">
        <div className="p-6 border-b border-near-black/[0.08]">
          <h4 className="text-[15px] font-semibold tracking-tight">Get aligned with Caye</h4>
          <p className="text-[12px] text-near-black/55 mt-1 leading-snug">
            {stage === 'loading'
              ? 'Reading your last messages…'
              : profile
                ? `Caye read ${sampleCount} of your sent messages. Edit anything that doesn't sound like you.`
                : 'Caye couldn\'t finish reading.'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {stage === 'loading' && (
            <div className="flex items-center gap-2.5 text-near-black/45 py-8 justify-center">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0FB5A1] animate-pulse" />
              <span className="text-[12px] font-mono tracking-[0.04em] animate-pulse">
                Listening to your voice…
              </span>
            </div>
          )}

          {error && stage !== 'loading' && (
            <div className="text-[12.5px] text-[#c94824] bg-[#c94824]/[0.06] border border-[#c94824]/20 rounded-lg px-3 py-2.5">
              {error}
            </div>
          )}

          {profile && stage !== 'loading' && (
            <>
              <div className="rounded-xl bg-cream/40 border border-near-black/[0.06] p-3.5">
                <div className="text-[10.5px] font-mono tracking-[0.12em] uppercase text-near-black/45 font-semibold mb-1">
                  How I think you write
                </div>
                <div className="text-[12.5px] text-near-black/80 leading-snug">
                  {profile.writing_style}
                </div>
                <div className="text-[11.5px] text-near-black/55 leading-snug mt-1.5 italic">
                  {profile.tone_notes}
                </div>
              </div>

              <Field
                label="Your opener"
                hint="The first line Caye should use on new threads"
                value={profile.standard_opener ?? ''}
                onChange={(v) => patch('standard_opener', v || null)}
              />

              <Field
                label="Your sign-off line"
                hint="The closing line right before your signature"
                value={profile.standard_signoff ?? ''}
                onChange={(v) => patch('standard_signoff', v || null)}
              />

              <Field
                label="Your signature"
                hint="Caye appends this verbatim — line breaks and all"
                value={profile.signature_block ?? ''}
                onChange={(v) => patch('signature_block', v || null)}
                multiline
              />

              <Field
                label="Your tagline"
                hint="Always goes after the signature"
                value={profile.tagline ?? ''}
                onChange={(v) => patch('tagline', v || null)}
              />
            </>
          )}
        </div>

        <div className="p-6 pt-4 border-t border-near-black/[0.08] flex items-center justify-between gap-3">
          <button
            onClick={onClose}
            disabled={stage === 'saving'}
            className="text-[12px] text-near-black/55 hover:text-near-black/85 disabled:opacity-40 cursor-pointer transition-colors"
          >
            Skip for now
          </button>
          <button
            onClick={confirm}
            disabled={!profile || stage === 'loading' || stage === 'saving'}
            className="bg-[#0FB5A1] hover:bg-[#0FB5A1]/90 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-[12px] font-semibold cursor-pointer shadow-sm transition-all"
          >
            {stage === 'saving' ? 'Saving…' : 'This is me'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  multiline,
}: {
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  multiline?: boolean
}) {
  return (
    <label className="block">
      <div className="text-[10.5px] font-mono tracking-[0.12em] uppercase text-near-black/45 font-semibold mb-1">
        {label}
      </div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className="w-full bg-cream/40 border border-near-black/12 rounded-lg px-3 py-2 text-[13px] text-near-black focus:outline-none focus:border-near-black/30 focus:bg-white transition-colors font-mono leading-snug"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-cream/40 border border-near-black/12 rounded-lg px-3 py-2 text-[13px] text-near-black focus:outline-none focus:border-near-black/30 focus:bg-white transition-colors"
        />
      )}
      <div className="text-[10.5px] text-near-black/45 mt-1 leading-snug">{hint}</div>
    </label>
  )
}
