'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

interface SetupStatus {
  operatorWhatsappVerified: boolean
  whatsappConnected: boolean
  zohoConnected: boolean
}

export default function SetupChecklist() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<SetupStatus>({
    operatorWhatsappVerified: false,
    whatsappConnected: false,
    zohoConnected: false,
  })
  const [otpOpen, setOtpOpen] = useState(false)

  async function refresh() {
    if (!workspaceId) return
    try {
      const supabase = getSupabase()

      const [{ data: accounts }, { data: cfg }] = await Promise.all([
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
      ])

      const whatsappConnected = (accounts || []).some((a) => a.channel_type === 'whatsapp')
      const zohoConnected = (accounts || []).some((a) => a.channel_type === 'email')
      const operatorWhatsappVerified = Boolean(cfg?.operator_whatsapp_verified_at)

      setStatus({ operatorWhatsappVerified, whatsappConnected, zohoConnected })
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
      <div className="bg-[#0E1A1A] text-white rounded-2xl p-6 shadow-md font-sans">
        <p className="text-white/50 text-xs animate-pulse">Checking setup progress…</p>
      </div>
    )
  }

  const allDone =
    status.operatorWhatsappVerified && status.whatsappConnected && status.zohoConnected
  if (allDone) return null

  const items = [
    {
      label: 'Share your WhatsApp with Caye',
      done: status.operatorWhatsappVerified,
      actionLabel: 'Connect',
      onClick: () => setOtpOpen(true),
    },
    {
      label: 'Connect Zoho Mail + Calendar',
      done: status.zohoConnected,
      actionLabel: 'Connect',
      onClick: () => router.push(`/dashboard/${workspaceId}/settings?tab=channels`),
    },
    {
      label: 'Connect WhatsApp Business',
      done: status.whatsappConnected,
      actionLabel: 'Connect',
      onClick: () => router.push(`/dashboard/${workspaceId}/settings?tab=channels`),
    },
  ]

  return (
    <>
      <div className="bg-[#0E1A1A] text-white rounded-2xl p-6 shadow-md font-sans space-y-5">
        <div>
          <h3 className="font-semibold text-[15px] leading-tight text-white">
            Connect your channels
          </h3>
          <p className="text-[11.5px] text-white/50 mt-1">
            Caye reads your inbox and figures out the rest.
          </p>
        </div>

        <ul className="divide-y divide-white/[0.08]">
          {items.map((item, idx) => (
            <li
              key={idx}
              className="py-3 flex items-center justify-between gap-4 first:pt-0 last:pb-0"
            >
              <div className="flex items-center gap-3">
                {item.done ? (
                  <span className="text-[#0FB5A1] font-bold text-base w-5 h-5 flex items-center justify-center">
                    ✓
                  </span>
                ) : (
                  <div className="w-5 h-5 rounded-full border border-white/20 flex-shrink-0" />
                )}
                <span
                  className={`text-[13px] ${item.done ? 'text-white/40 line-through' : 'text-white'}`}
                >
                  {item.label}
                </span>
              </div>

              {!item.done && (
                <button
                  onClick={item.onClick}
                  className="bg-white/10 hover:bg-white/15 text-white px-3 py-1 rounded-md text-xs font-semibold transition-colors flex items-center gap-1 cursor-pointer"
                >
                  {item.actionLabel} <span className="opacity-70">›</span>
                </button>
              )}
            </li>
          ))}
        </ul>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[#0E1A1A] text-white rounded-2xl p-6 w-[400px] max-w-[90vw] space-y-4 font-sans">
        <div>
          <h4 className="text-[15px] font-semibold">
            {stage === 'enter-phone'
              ? 'Share your WhatsApp with Caye'
              : 'Enter the 6-digit code'}
          </h4>
          <p className="text-[12px] text-white/50 mt-1">
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
            className="w-full bg-white/[0.06] border border-white/10 rounded-md px-3 py-2 text-[14px] focus:outline-none focus:border-white/30"
          />
        ) : (
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="123456"
            className="w-full bg-white/[0.06] border border-white/10 rounded-md px-3 py-2 text-[14px] tracking-[0.5em] text-center focus:outline-none focus:border-white/30"
          />
        )}

        {error && <p className="text-[12px] text-[#FF8A8A]">{error}</p>}

        <div className="flex items-center justify-between gap-3 pt-1">
          <button
            onClick={onClose}
            className="text-[12px] text-white/50 hover:text-white/80 cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={stage === 'enter-phone' ? sendCode : verifyCode}
            disabled={busy || (stage === 'enter-phone' ? phone.length < 7 : code.length !== 6)}
            className="bg-[#0FB5A1] hover:bg-[#0FB5A1]/90 disabled:opacity-40 disabled:cursor-not-allowed text-[#0A1818] px-4 py-2 rounded-md text-[12px] font-semibold cursor-pointer"
          >
            {busy ? '…' : stage === 'enter-phone' ? 'Send code' : 'Verify'}
          </button>
        </div>
      </div>
    </div>
  )
}
