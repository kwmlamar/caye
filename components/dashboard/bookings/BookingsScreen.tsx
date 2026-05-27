'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { getSupabase } from '@/lib/supabase'
import { useWorkspace } from '@/lib/workspace-context'
import { CayeMark } from '@/components/brand/CayeMark'
import BookingModal, { type BookingModalData } from '../calendar/BookingModal'
import { useDashboard } from '@/lib/dashboard-context'

interface BookingRow {
  id: string
  customer_name: string
  customer_phone: string | null
  customer_email: string | null
  service_id: string | null
  booking_date: string
  booking_time: string
  number_of_people: number
  duration_minutes: number | null
  status: 'confirmed' | 'pending' | 'completed' | 'cancelled'
  notes: string | null
  conversation_id: string | null
  service: { name: string; duration_minutes: number; is_shared: boolean; max_capacity: number }[] | null
}

function fmtTime(timeStr: string): string {
  if (!timeStr) return ''
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`
}

function bookingToForm(b: BookingRow): BookingModalData {
  return {
    id: b.id,
    service_id: b.service_id,
    customer_name: b.customer_name,
    customer_phone: b.customer_phone ?? '',
    customer_email: b.customer_email ?? '',
    booking_date: b.booking_date,
    booking_time: b.booking_time.slice(0, 5),
    number_of_people: b.number_of_people,
    duration_minutes: b.duration_minutes,
    status: b.status === 'completed' || b.status === 'cancelled' ? 'confirmed' : b.status, // clamp to modal active states
    notes: b.notes ?? '',
  }
}

export default function BookingsScreen({ inPanel = false }: { inPanel?: boolean }) {
  const { workspaceId } = useWorkspace()
  const { isPanelDetail, setIsPanelDetail } = useDashboard()
  const [bookings, setBookings] = useState<BookingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'CONFIRMED' | 'PENDING'>('ALL')
  const [selectedBooking, setSelectedBooking] = useState<{ mode: 'edit'; data: BookingModalData } | null>(null)

  const fetchBookings = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('bookings')
        .select('id, customer_name, customer_phone, customer_email, service_id, booking_date, booking_time, number_of_people, duration_minutes, status, notes, conversation_id, service:booking_services(name, duration_minutes, is_shared, max_capacity)')
        .eq('user_id', workspaceId)
        .neq('status', 'cancelled')
        .order('booking_date', { ascending: false })

      if (!error && data) {
        setBookings(data as unknown as BookingRow[])
      }
    } catch (err) {
      console.error('[BookingsScreen] Failed to load bookings:', err)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    fetchBookings()
  }, [fetchBookings])

  useEffect(() => {
    if (inPanel && !isPanelDetail) {
      setSelectedBooking(null)
    }
  }, [isPanelDetail, inPanel])

  const filteredBookings = bookings.filter(b => {
    const matchesSearch = b.customer_name.toLowerCase().includes(search.toLowerCase()) ||
      (b.service?.[0]?.name || 'Island Tour').toLowerCase().includes(search.toLowerCase())
    
    const matchesStatus = statusFilter === 'ALL' ||
      (statusFilter === 'CONFIRMED' && b.status === 'confirmed') ||
      (statusFilter === 'PENDING' && b.status === 'pending')

    return matchesSearch && matchesStatus
  })

  if (inPanel && selectedBooking && workspaceId) {
    return (
      <BookingModal
        workspaceId={workspaceId}
        initial={selectedBooking.data}
        mode={selectedBooking.mode}
        inline={true}
        onClose={() => {
          setSelectedBooking(null)
          setIsPanelDetail(false)
        }}
        onSaved={() => {
          setSelectedBooking(null)
          setIsPanelDetail(false)
          fetchBookings()
        }}
      />
    )
  }

  return (
    <div className={`flex-1 flex flex-col bg-cream overflow-hidden font-sans ${inPanel ? 'p-3' : 'p-6 md:p-8'}`}>
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
        {!inPanel && (
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-near-black">Bookings</h2>
            <p className="text-near-black/55 text-xs mt-1">Manage and track guest tour bookings created by Caye or manual entry.</p>
          </div>
        )}

        {/* Search & Filter bar */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="flex items-center gap-2 bg-white border border-near-black/10 rounded-xl px-3 py-1.5 w-full sm:w-64 shadow-sm focus-within:border-near-black/20">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-45">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              type="text"
              placeholder="Search bookings…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="text-xs text-near-black bg-transparent outline-none border-none placeholder-near-black/35 w-full"
            />
          </div>

          {/* Status Segment */}
          <div className="flex bg-near-black/5 rounded-xl p-1 text-[11px] font-semibold">
            <button
              onClick={() => setStatusFilter('ALL')}
              className={`px-2.5 py-1 rounded-lg transition-all ${statusFilter === 'ALL' ? 'bg-white text-near-black shadow-sm' : 'text-near-black/60 hover:text-near-black'}`}
            >
              All
            </button>
            <button
              onClick={() => setStatusFilter('CONFIRMED')}
              className={`px-2.5 py-1 rounded-lg transition-all ${statusFilter === 'CONFIRMED' ? 'bg-white text-near-black shadow-sm' : 'text-near-black/60 hover:text-near-black'}`}
            >
              Confirmed
            </button>
            <button
              onClick={() => setStatusFilter('PENDING')}
              className={`px-2.5 py-1 rounded-lg transition-all ${statusFilter === 'PENDING' ? 'bg-white text-near-black shadow-sm' : 'text-near-black/60 hover:text-near-black'}`}
            >
              Pending
            </button>
          </div>
        </div>
      </header>

      {/* Main Table Area */}
      <div className="flex-1 bg-white rounded-2xl border border-near-black/10 shadow-sm overflow-hidden flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-near-black/45 text-sm py-12">
            Loading bookings…
          </div>
        ) : filteredBookings.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-near-black/45 text-center p-8 py-20">
            <div className="w-12 h-12 rounded-full bg-near-black/5 flex items-center justify-center mb-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
            </div>
            <h3 className="font-semibold text-near-black/85 text-[15px]">No bookings found</h3>
            <p className="text-xs text-near-black/50 max-w-[280px] mt-1">Try adjusting your filters or search query.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-near-black/5 text-near-black/40 font-mono tracking-wider uppercase font-semibold bg-near-black/[0.01]">
                  <th className="p-3 pl-4">Date & Time</th>
                  <th className="p-3">Guest Name</th>
                  {!inPanel && <th className="p-3">Excursion</th>}
                  {!inPanel && <th className="p-3">Guests</th>}
                  {!inPanel && <th className="p-3">Status</th>}
                  {!inPanel && <th className="p-3">Source</th>}
                  <th className="p-3 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-near-black/5 text-near-black/85">
                {filteredBookings.map((b) => {
                  const isCaye = !!b.conversation_id
                  const tourName = b.service?.[0]?.name || 'Island Tour'
                  return (
                    <tr key={b.id} className="hover:bg-near-black/[0.01] transition-colors">
                      <td className="p-3 pl-4 font-semibold">
                        <div className="font-mono text-near-black/90">
                          {new Date(b.booking_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(inPanel ? {} : { year: 'numeric' }) })}
                        </div>
                        <div className="text-[10px] text-near-black/45 mt-0.5">{fmtTime(b.booking_time)}</div>
                      </td>
                      <td className="p-3 font-semibold">
                        <div>{b.customer_name}</div>
                        {inPanel && (
                          <div className="text-[10px] text-near-black/45 font-normal mt-0.5">
                            {tourName} · {b.number_of_people} guests
                          </div>
                        )}
                      </td>
                      {!inPanel && <td className="p-3">{tourName}</td>}
                      {!inPanel && <td className="p-3 font-mono font-medium">{b.number_of_people}</td>}
                      {!inPanel && (
                        <td className="p-3">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                            b.status === 'confirmed'
                              ? 'bg-[#E6F2F0] text-[#1E6157]'
                              : 'bg-[#fce8e1] text-[#c94824]'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${b.status === 'confirmed' ? 'bg-[#0FB5A1]' : 'bg-[#e85a3c]'}`} />
                            {b.status}
                          </span>
                        </td>
                      )}
                      {!inPanel && (
                        <td className="p-3">
                          {isCaye ? (
                            <span className="inline-flex items-center gap-1 text-[#1E6157] font-mono text-[10px] font-semibold bg-[#E6F2F0] px-2 py-0.5 rounded">
                              <CayeMark size={10} /> Caye
                            </span>
                          ) : (
                            <span className="text-near-black/40 font-mono text-[10px]">Manual</span>
                          )}
                        </td>
                      )}
                      <td className="p-3 pr-4 text-right">
                        <button
                          onClick={() => {
                            setSelectedBooking({ mode: 'edit', data: bookingToForm(b) })
                            if (inPanel) {
                              setIsPanelDetail(true)
                            }
                          }}
                          className="text-near-black hover:text-caribbean-teal text-xs font-semibold px-2.5 py-1.5 border border-near-black/10 hover:border-caribbean-teal/30 rounded-lg bg-white shadow-sm hover:scale-[1.01] transition-all cursor-pointer"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Editing Booking Modal Integration (when not in panel) */}
      {!inPanel && selectedBooking && workspaceId && (
        <BookingModal
          workspaceId={workspaceId}
          initial={selectedBooking.data}
          mode={selectedBooking.mode}
          onClose={() => setSelectedBooking(null)}
          onSaved={() => { setSelectedBooking(null); fetchBookings() }}
        />
      )}
    </div>
  )
}
