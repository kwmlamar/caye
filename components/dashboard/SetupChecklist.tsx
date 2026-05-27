'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

interface SetupStatus {
  whatsappConnected: boolean
  zohoConnected: boolean
}

export default function SetupChecklist() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<SetupStatus>({
    whatsappConnected: false,
    zohoConnected: false,
  })

  useEffect(() => {
    async function checkSetup() {
      if (!workspaceId) return
      try {
        const supabase = getSupabase()

        const { data: accounts } = await supabase
          .from('connected_accounts')
          .select('channel_type, is_active')
          .eq('user_id', workspaceId)
          .eq('is_active', true)

        const whatsappConnected = (accounts || []).some(a => a.channel_type === 'whatsapp')
        const zohoConnected = (accounts || []).some(a => a.channel_type === 'email')

        setStatus({ whatsappConnected, zohoConnected })
      } catch (err) {
        console.error('[SetupChecklist] Failed to query setup status:', err)
      } finally {
        setLoading(false)
      }
    }

    checkSetup()
  }, [workspaceId])

  if (loading) {
    return (
      <div className="bg-[#0E1A1A] text-white rounded-2xl p-6 shadow-md font-sans">
        <p className="text-white/50 text-xs animate-pulse">Checking setup progress…</p>
      </div>
    )
  }

  const allDone = status.whatsappConnected && status.zohoConnected
  if (allDone) return null

  const items = [
    {
      label: 'Connect WhatsApp Business',
      done: status.whatsappConnected,
      actionLabel: 'Connect',
      path: `/dashboard/${workspaceId}/settings?tab=channels`,
    },
    {
      label: 'Connect Zoho Mail + Calendar',
      done: status.zohoConnected,
      actionLabel: 'Connect',
      path: `/dashboard/${workspaceId}/settings?tab=channels`,
    },
  ]

  return (
    <div className="bg-[#0E1A1A] text-white rounded-2xl p-6 shadow-md font-sans space-y-5">
      <div>
        <h3 className="font-semibold text-[15px] leading-tight text-white">Connect your channels</h3>
        <p className="text-[11.5px] text-white/50 mt-1">Caye reads your inbox and figures out the rest.</p>
      </div>

      <ul className="divide-y divide-white/[0.08]">
        {items.map((item, idx) => (
          <li key={idx} className="py-3 flex items-center justify-between gap-4 first:pt-0 last:pb-0">
            <div className="flex items-center gap-3">
              {item.done ? (
                <span className="text-[#0FB5A1] font-bold text-base w-5 h-5 flex items-center justify-center">✓</span>
              ) : (
                <div className="w-5 h-5 rounded-full border border-white/20 flex-shrink-0" />
              )}
              <span className={`text-[13px] ${item.done ? 'text-white/40 line-through' : 'text-white'}`}>
                {item.label}
              </span>
            </div>

            {!item.done && (
              <button
                onClick={() => router.push(item.path)}
                className="bg-white/10 hover:bg-white/15 text-white px-3 py-1 rounded-md text-xs font-semibold transition-colors flex items-center gap-1 cursor-pointer"
              >
                {item.actionLabel} <span className="opacity-70">›</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

