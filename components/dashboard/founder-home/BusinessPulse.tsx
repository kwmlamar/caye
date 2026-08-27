'use client'

import type { CommandOverview } from '@/lib/useCommandOverview'
import type { TodayStats } from '@/lib/useTodayStats'
import { TEXT_QUIET } from '../surface'

// Compact structured context UNDER Caye's spoken sentence (SnapshotCard's
// buildBriefingLine), not a KPI grid competing with it — one quiet inline
// line, dot-separated, no card chrome. Used to be a set of large editorial
// numbers (the page's own hero); now that the sentence carries the
// headline, this only needs to read as a supporting caption.
//
// Deliberately excludes LLM/API spend — operational cost is an internal
// economics question (Operations → Cost), not something Caye reports
// about herself in the daily brief to the person who employs her.
export default function BusinessPulse({ data, today, weekLabel, className }: {
  data: CommandOverview | null
  today: TodayStats | null
  weekLabel: string
  className?: string
}) {
  if (!data) return null

  const parts: string[] = [`${data.bookings.length} ${weekLabel.toLowerCase()}`]
  if (today && today.customersAnswered > 0) parts.push(`${today.customersAnswered} answered today`)
  if (data.pending_escalation_count > 0) {
    parts.push(`${data.pending_escalation_count} need${data.pending_escalation_count === 1 ? 's' : ''} you`)
  }

  return (
    <div className={className} style={{ fontSize: 12.5, color: TEXT_QUIET, padding: '0 2px' }}>
      {parts.join(' · ')}
    </div>
  )
}
