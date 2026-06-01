'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
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

type BucketKey = 'today' | 'tomorrow' | 'thisWeek' | 'later' | 'past'

const BUCKET_LABELS: Record<BucketKey, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  thisWeek: 'This week',
  later: 'Later',
  past: 'Past',
}

function fmtTime(timeStr: string): string {
  if (!timeStr) return ''
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`
}

function ymdToDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00`)
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime()
  return Math.round(ms / 86_400_000)
}

function bucketFor(bookingDate: Date, today: Date): BucketKey {
  const delta = daysBetween(today, bookingDate)
  if (delta < 0) return 'past'
  if (delta === 0) return 'today'
  if (delta === 1) return 'tomorrow'
  if (delta <= 7) return 'thisWeek'
  return 'later'
}

function smartDateLabel(bookingDate: Date, today: Date): { primary: string; secondary: string | null } {
  const delta = daysBetween(today, bookingDate)
  if (delta === 0) return { primary: 'Today', secondary: null }
  if (delta === 1) return { primary: 'Tomorrow', secondary: null }
  if (delta === -1) return { primary: 'Yesterday', secondary: null }
  if (delta > 1 && delta <= 6) {
    return {
      primary: bookingDate.toLocaleDateString('en-US', { weekday: 'long' }),
      secondary: bookingDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    }
  }
  return {
    primary: bookingDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    secondary: bookingDate.getFullYear() !== today.getFullYear()
      ? String(bookingDate.getFullYear())
      : null,
  }
}

function statusAccent(status: BookingRow['status'], isPast: boolean): string {
  if (isPast) return 'bg-near-black/15'
  if (status === 'confirmed') return 'bg-[#0FB5A1]'
  if (status === 'pending') return 'bg-[#e85a3c]'
  return 'bg-near-black/15'
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
    status: b.status === 'completed' || b.status === 'cancelled' ? 'confirmed' : b.status,
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

  const today = useMemo(() => {
    const t = new Date()
    t.setHours(0, 0, 0, 0)
    return t
  }, [])

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
        .order('booking_date', { ascending: true })
        .order('booking_time', { ascending: true })

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
    const matchesSearch = !search ||
      b.customer_name.toLowerCase().includes(search.toLowerCase()) ||
      (b.service?.[0]?.name || 'Island Tour').toLowerCase().includes(search.toLowerCase())
    const matchesStatus = statusFilter === 'ALL' ||
      (statusFilter === 'CONFIRMED' && b.status === 'confirmed') ||
      (statusFilter === 'PENDING' && b.status === 'pending')
    return matchesSearch && matchesStatus
  })

  // Group and re-order: future buckets ASC, then past DESC (most recent past first).
  const groupedBookings = useMemo(() => {
    const groups: Record<BucketKey, BookingRow[]> = {
      today: [], tomorrow: [], thisWeek: [], later: [], past: [],
    }
    for (const b of filteredBookings) {
      const date = ymdToDate(b.booking_date)
      groups[bucketFor(date, today)].push(b)
    }
    // past list comes back ASC; flip so newest past is at top of the past group.
    groups.past.reverse()
    return groups
  }, [filteredBookings, today])

  // Attention strip: today's count + pending count across the next 7 days.
  const attention = useMemo(() => {
    const todayCount = groupedBookings.today.length
    const pendingSoon = [...groupedBookings.today, ...groupedBookings.tomorrow, ...groupedBookings.thisWeek]
      .filter(b => b.status === 'pending').length
    const nextUp = groupedBookings.today[0]
      ?? groupedBookings.tomorrow[0]
      ?? groupedBookings.thisWeek[0]
      ?? groupedBookings.later[0]
      ?? null
    return { todayCount, pendingSoon, nextUp }
  }, [groupedBookings])

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

  const orderedBuckets: BucketKey[] = ['today', 'tomorrow', 'thisWeek', 'later', 'past']
  const hasAnyBookings = filteredBookings.length > 0
  const hasAttention = attention.todayCount > 0 || attention.pendingSoon > 0

  return (
    <div className={`flex-1 flex flex-col ${inPanel ? 'bg-transparent p-3' : 'bg-cream p-6 md:p-8'} overflow-hidden font-sans`}>
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
        {!inPanel && (
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-near-black">Bookings</h2>
            <p className="text-near-black/55 text-xs mt-1">Manage and track guest tour bookings created by Caye or manual entry.</p>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
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

      {/* Attention strip — only renders when there's signal to surface. */}
      {!loading && hasAttention && (
        <div className="mb-3 bg-white border border-near-black/10 rounded-xl px-3.5 py-2.5 shadow-sm flex items-center gap-4 flex-wrap">
          {attention.todayCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#0FB5A1] animate-pulse" />
              <span className="text-[11px] font-semibold tracking-wide uppercase text-near-black/55">Today</span>
              <span className="text-sm font-semibold text-near-black">{attention.todayCount}</span>
            </div>
          )}
          {attention.pendingSoon > 0 && (
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#e85a3c]" />
              <span className="text-[11px] font-semibold tracking-wide uppercase text-near-black/55">Pending · next 7d</span>
              <span className="text-sm font-semibold text-near-black">{attention.pendingSoon}</span>
            </div>
          )}
          {attention.nextUp && (
            <div className="flex items-center gap-2 ml-auto min-w-0">
              <span className="text-[11px] font-semibold tracking-wide uppercase text-near-black/45 shrink-0">Next up</span>
              <span className="text-xs text-near-black/85 truncate">
                {attention.nextUp.customer_name} · {fmtTime(attention.nextUp.booking_time)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Main list */}
      <div className="flex-1 bg-white rounded-2xl border border-near-black/10 shadow-sm overflow-hidden flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-near-black/45 text-sm py-12">
            Loading bookings…
          </div>
        ) : !hasAnyBookings ? (
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
            {orderedBuckets.map(bucket => {
              const rows = groupedBookings[bucket]
              if (rows.length === 0) return null
              const isPastBucket = bucket === 'past'
              return (
                <section key={bucket}>
                  <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm border-b border-near-black/5 px-4 py-2 flex items-center justify-between">
                    <span className="text-[10px] font-mono tracking-[0.18em] uppercase text-near-black/45 font-semibold">
                      {BUCKET_LABELS[bucket]}
                    </span>
                    <span className="text-[10px] font-mono text-near-black/35">{rows.length}</span>
                  </div>
                  <ul className="divide-y divide-near-black/5">
                    {rows.map(b => {
                      const isCaye = !!b.conversation_id
                      const tourName = b.service?.[0]?.name || 'Island Tour'
                      const date = ymdToDate(b.booking_date)
                      const label = smartDateLabel(date, today)
                      const accent = statusAccent(b.status, isPastBucket)
                      return (
                        <li
                          key={b.id}
                          className={`group relative flex items-stretch gap-3 px-4 py-3 hover:bg-near-black/[0.015] transition-colors ${isPastBucket ? 'opacity-70' : ''}`}
                        >
                          <span
                            aria-hidden
                            className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-r ${accent}`}
                          />

                          <div className="flex-shrink-0 w-[88px] pl-1">
                            <div className="text-[13px] font-semibold text-near-black leading-tight">
                              {label.primary}
                            </div>
                            {label.secondary && (
                              <div className="text-[10px] text-near-black/45 font-mono mt-0.5">
                                {label.secondary}
                              </div>
                            )}
                            <div className="text-[10px] text-near-black/55 font-mono mt-0.5">
                              {fmtTime(b.booking_time)}
                            </div>
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[13px] font-semibold text-near-black truncate">
                                {b.customer_name}
                              </span>
                              {b.status === 'pending' && !isPastBucket && (
                                <span className="text-[9px] font-bold tracking-wider uppercase text-[#c94824] bg-[#fce8e1] px-1.5 py-0.5 rounded">
                                  Pending
                                </span>
                              )}
                              {isCaye && (
                                <span className="inline-flex items-center gap-1 text-[9px] font-mono font-semibold text-[#1E6157] bg-[#E6F2F0] px-1.5 py-0.5 rounded">
                                  <CayeMark size={9} />
                                  Caye
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-near-black/55 mt-0.5 truncate">
                              {tourName} · {b.number_of_people} {b.number_of_people === 1 ? 'guest' : 'guests'}
                            </div>
                          </div>

                          <div className="flex items-center">
                            <button
                              onClick={() => {
                                setSelectedBooking({ mode: 'edit', data: bookingToForm(b) })
                                if (inPanel) setIsPanelDetail(true)
                              }}
                              className="text-near-black/70 hover:text-near-black text-[11px] font-semibold px-2.5 py-1 border border-near-black/10 hover:border-near-black/25 rounded-md bg-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                            >
                              Edit
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </div>

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
