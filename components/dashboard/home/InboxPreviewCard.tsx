'use client'

import React from 'react'
import ChannelIcon from '@/components/ui/ChannelIcon'
import Avatar from '@/components/ui/Avatar'
import { useDashboard } from '@/lib/dashboard-context'
import type { ChannelType } from '@/lib/types'

export interface InboxRowData {
  id: string
  customer_id: string
  customer_name: string
  channel_type: 'whatsapp' | 'instagram' | 'messenger' | 'email'
  preview: string
  status: 'held' | 'replied' | 'drafted'
  last_message_at: string
  unread_count: number
}

// Convert DB channel type to UI ChannelType
function toUiChannel(ch: string): ChannelType {
  if (ch === 'whatsapp') return 'wa'
  if (ch === 'instagram') return 'ig'
  if (ch === 'messenger') return 'fb'
  return 'em'
}

export function InboxPreviewCard({ data }: { data: InboxRowData[] }) {
  const { setPanelScreen, setPanelOpen, setPendingContactChannelId } = useDashboard()

  const handleOpenConversation = (e: React.MouseEvent, customerId: string) => {
    e.preventDefault()
    setPendingContactChannelId(customerId)
    setPanelScreen('chats')
    setPanelOpen(true)
  }

  return (
    <div className="bg-white rounded-xl border border-near-black/10 shadow-sm w-full max-w-md overflow-hidden hover:border-caribbean-teal/20 transition-colors">
      <div className="bg-near-black/[0.02] border-b border-near-black/5 px-4 py-2.5 flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-near-black/40 font-bold">Inbox Preview</span>
        <span className="text-[10px] font-mono text-near-black/50">{data.length} {data.length === 1 ? 'item' : 'items'}</span>
      </div>

      <div className="divide-y divide-near-black/5">
        {data.map((row) => {
          const ch = toUiChannel(row.channel_type)
          
          return (
            <div key={row.id} className="p-4 flex items-start gap-3 hover:bg-near-black/[0.005] transition-colors relative">
              <div className="relative flex-shrink-0 mt-0.5">
                <Avatar name={row.customer_name} size={36} />
                <span className="absolute -bottom-1 -right-1 bg-white rounded-full p-0.5 shadow-sm border border-near-black/5 flex items-center justify-center">
                  <ChannelIcon ch={ch} size={13} />
                </span>
              </div>

              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <h5 className="text-xs font-semibold text-near-black truncate">{row.customer_name}</h5>
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8.5px] font-bold uppercase tracking-wider ${
                    row.status === 'held'
                      ? 'bg-[#fce8e1] text-[#c94824]'
                      : row.status === 'drafted'
                      ? 'bg-near-black/5 text-near-black/60'
                      : 'bg-[#E6F2F0] text-[#1E6157]'
                  }`}>
                    {row.status === 'held' ? 'Held' : row.status === 'drafted' ? 'Draft' : 'Replied'}
                  </span>
                </div>
                
                <p className="text-[11.5px] text-near-black/60 line-clamp-2 leading-relaxed whitespace-pre-wrap">
                  {row.preview}
                </p>

                <div className="pt-2 flex items-center justify-between text-[10.5px]">
                  <span className="text-near-black/35 font-mono">
                    {new Date(row.last_message_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                  <a
                    href="#open-chat"
                    onClick={(e) => handleOpenConversation(e, row.customer_id)}
                    className="font-semibold text-caribbean-teal hover:text-caribbean-teal-hover transition-colors"
                  >
                    Open conversation <span>→</span>
                  </a>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
