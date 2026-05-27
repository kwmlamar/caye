'use client'

import React from 'react'
import { useDashboard } from '@/lib/dashboard-context'

export interface WeekDayData {
  date: string
  dow: string
  booked: boolean
  title?: string
}

export interface CalendarWeekData {
  days: WeekDayData[]
}

export function CalendarWeekStrip({ data }: { data: CalendarWeekData }) {
  const { setPanelScreen, setPanelOpen } = useDashboard()

  const handleOpenCalendar = (e: React.MouseEvent) => {
    e.preventDefault()
    setPanelScreen('calendar')
    setPanelOpen(true)
  }

  return (
    <div 
      onClick={handleOpenCalendar}
      className="bg-white rounded-xl border border-near-black/10 p-4 shadow-sm w-full max-w-md space-y-4 hover:border-caribbean-teal/30 transition-all cursor-pointer group"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-near-black/40 font-bold">Calendar Week Strip</span>
        <span className="text-[10px] font-mono text-near-black/35 group-hover:text-caribbean-teal transition-colors">Click to expand</span>
      </div>

      {/* Week Grid */}
      <div className="grid grid-cols-7 gap-2 text-center">
        {data.days.map((d, idx) => {
          const dateNum = new Date(d.date + 'T00:00:00').getDate()
          return (
            <div 
              key={idx} 
              className={`p-2 rounded-lg border flex flex-col items-center justify-center space-y-1 transition-colors ${
                d.booked 
                  ? 'bg-caribbean-teal/5 border-caribbean-teal/20' 
                  : 'bg-near-black/[0.01] border-near-black/5 hover:bg-near-black/5'
              }`}
              title={d.title || (d.booked ? 'Bookings scheduled' : 'No bookings')}
            >
              <span className="text-[10px] font-mono text-near-black/40 font-bold uppercase">{d.dow}</span>
              <span className={`text-xs font-semibold ${d.booked ? 'text-caribbean-teal font-bold' : 'text-near-black/70'}`}>
                {dateNum}
              </span>
              <span className={`w-1.5 h-1.5 rounded-full ${d.booked ? 'bg-caribbean-teal' : 'bg-transparent'}`} />
            </div>
          )
        })}
      </div>

      <div className="text-right">
        <a 
          href="#calendar" 
          onClick={handleOpenCalendar}
          className="text-[11px] font-semibold text-caribbean-teal group-hover:text-caribbean-teal-hover transition-colors inline-flex items-center gap-1"
        >
          Open week view <span>→</span>
        </a>
      </div>
    </div>
  )
}
