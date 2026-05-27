'use client'

import React from 'react'
import Avatar from '@/components/ui/Avatar'
import ChannelIcon from '@/components/ui/ChannelIcon'
import { useDashboard } from '@/lib/dashboard-context'
import type { ChannelType } from '@/lib/types'

export interface ContactCardData {
  id: string
  name: string
  channels: string[] // e.g. ['whatsapp', 'email']
  last_touch: string
}

// Convert DB channel type to UI ChannelType
function toUiChannel(ch: string): ChannelType {
  if (ch === 'whatsapp') return 'wa'
  if (ch === 'instagram') return 'ig'
  if (ch === 'messenger') return 'fb'
  return 'em'
}

export function ContactCard({ data }: { data: ContactCardData }) {
  const { setPanelScreen, setPanelOpen } = useDashboard()

  const handleOpenContact = (e: React.MouseEvent) => {
    e.preventDefault()
    setPanelScreen('contacts')
    setPanelOpen(true)
  }

  return (
    <div className="bg-white rounded-xl border border-near-black/10 p-4 shadow-sm w-full max-w-sm space-y-4 hover:border-caribbean-teal/30 transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-near-black/40 font-bold">Contact Profile</span>
      </div>

      <div className="flex items-center gap-3">
        <Avatar name={data.name} size={44} />
        <div className="space-y-1">
          <h4 className="text-sm font-semibold text-near-black leading-none">{data.name}</h4>
          <span className="text-[11px] text-near-black/45 block">Last touch: {data.last_touch}</span>
        </div>
      </div>

      <div className="border-t border-b border-near-black/5 py-3 flex items-center justify-between">
        <span className="text-[10px] uppercase font-mono tracking-wider text-near-black/40 font-bold">Active Channels</span>
        <div className="flex items-center gap-1.5">
          {data.channels.map((ch, idx) => (
            <span key={idx} className="bg-near-black/5 p-1 rounded-md flex items-center justify-center" title={ch}>
              <ChannelIcon ch={toUiChannel(ch)} size={14} />
            </span>
          ))}
        </div>
      </div>

      <div className="text-right">
        <a 
          href="#contacts" 
          onClick={handleOpenContact}
          className="text-[11px] font-semibold text-caribbean-teal hover:text-caribbean-teal-hover transition-colors inline-flex items-center gap-1"
        >
          Open contact <span>→</span>
        </a>
      </div>
    </div>
  )
}
