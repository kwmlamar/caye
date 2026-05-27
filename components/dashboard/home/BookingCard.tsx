'use client'

import React from 'react'
import { useDashboard } from '@/lib/dashboard-context'

export interface BookingCardData {
  id: string
  customer_name: string
  tour: string
  date: string
  time: string
  guests: number
  status: 'confirmed' | 'pending'
}

export function BookingCard({ data }: { data: BookingCardData }) {
  const { setPanelScreen, setPanelOpen } = useDashboard()

  const handleOpenCalendar = (e: React.MouseEvent) => {
    e.preventDefault()
    setPanelScreen('calendar')
    setPanelOpen(true)
  }

  const formattedDate = new Date(data.date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  // Format time (e.g. "09:30" to "9:30am")
  const formatTime = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    const ampm = h >= 12 ? 'pm' : 'am'
    return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`
  }

  return (
    <div className="bg-white rounded-xl border border-near-black/10 p-4 shadow-sm w-full max-w-sm space-y-4 hover:border-caribbean-teal/30 transition-colors">
      <div className="flex items-start justify-between">
        <div className="space-y-0.5">
          <span className="text-[10px] font-mono uppercase tracking-widest text-near-black/40 font-bold">Booking Details</span>
          <h4 className="text-sm font-semibold text-near-black">{data.customer_name}</h4>
        </div>
        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
          data.status === 'confirmed' ? 'bg-[#E6F2F0] text-[#1E6157]' : 'bg-[#fce8e1] text-[#c94824]'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${data.status === 'confirmed' ? 'bg-[#0FB5A1]' : 'bg-[#e85a3c]'}`} />
          {data.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-b border-near-black/5 py-3 text-xs">
        <div>
          <span className="text-near-black/45 block text-[10px] uppercase font-mono tracking-wider">Tour</span>
          <span className="font-medium text-near-black/85 truncate block">{data.tour}</span>
        </div>
        <div>
          <span className="text-near-black/45 block text-[10px] uppercase font-mono tracking-wider">Date & Time</span>
          <span className="font-semibold text-near-black/85">{formattedDate} · {formatTime(data.time)}</span>
        </div>
        <div className="mt-2">
          <span className="text-near-black/45 block text-[10px] uppercase font-mono tracking-wider">Guests</span>
          <span className="font-semibold text-near-black/85">{data.guests} {data.guests === 1 ? 'passenger' : 'passengers'}</span>
        </div>
      </div>

      <div className="text-right">
        <a 
          href="#calendar" 
          onClick={handleOpenCalendar}
          className="text-[11px] font-semibold text-caribbean-teal hover:text-caribbean-teal-hover transition-colors inline-flex items-center gap-1"
        >
          Open in calendar <span>→</span>
        </a>
      </div>
    </div>
  )
}
