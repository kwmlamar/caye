'use client'

import { useEffect, useState } from 'react'
import { Pill, GhostButton } from '@/components/dashboard/founder-home/console-ui'

const CARD_BORDER = '#1f1f23'
const GLASS = { backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' } as const

export type CodingSessionStatus = 'booting' | 'running' | 'testing' | 'pushed' | 'failed' | 'timed_out' | 'killed'

export interface CodingSessionData {
  id: string
  task: string
  status: CodingSessionStatus
  final_commit_sha: string | null
  gate_output: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface CodingSessionMessageData {
  id: string
  kind: string
  body: string
  created_at: string
}

const STATUS_COLOR: Record<CodingSessionStatus, string> = {
  booting: '#a1a1aa',
  running: '#7DC9CB',
  testing: '#e0b95c',
  pushed: '#34d399',
  failed: '#f87171',
  timed_out: '#f87171',
  killed: '#a1a1aa',
}

const STATUS_LABEL: Record<CodingSessionStatus, string> = {
  booting: 'Booting sandbox',
  running: 'Running',
  testing: 'Testing + building',
  pushed: 'Pushed to main',
  failed: 'Failed',
  timed_out: 'Timed out',
  killed: 'Killed',
}

const KIND_LABEL: Record<string, string> = {
  assistant_text: '',
  tool_call: 'TOOL',
  tool_result: 'RESULT',
  file_edit: 'EDIT',
  commit: 'COMMIT',
  system: 'SYSTEM',
  error: 'ERROR',
  summary: 'SUMMARY',
}

function elapsed(since: string | null): string {
  if (!since) return ''
  const ms = Date.now() - new Date(since).getTime()
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

const ACTIVE_STATUSES: CodingSessionStatus[] = ['booting', 'running', 'testing']

function MessageRow({ m }: { m: CodingSessionMessageData }) {
  const label = KIND_LABEL[m.kind] ?? m.kind.toUpperCase()
  const isError = m.kind === 'error'
  return (
    <div style={{ padding: '6px 0', borderBottom: `1px solid ${CARD_BORDER}` }}>
      {label && (
        <span style={{
          fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.08em',
          color: isError ? '#f87171' : '#52525b', marginRight: 8,
        }}>
          {label}
        </span>
      )}
      <span style={{
        fontSize: 12.5, lineHeight: 1.55, color: isError ? '#f87171' : '#d4d4d8',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {m.body}
      </span>
    </div>
  )
}

export function CodingSessionCard({
  session,
  messages,
  onKill,
  killing,
}: {
  session: CodingSessionData
  messages: CodingSessionMessageData[]
  onKill: () => void
  killing: boolean
}) {
  const [, forceTick] = useState(0)

  // Re-render once a second while active so the elapsed-time label ticks —
  // no data refetch involved, that's the parent's polling job.
  useEffect(() => {
    if (!ACTIVE_STATUSES.includes(session.status)) return
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [session.status])

  const isActive = ACTIVE_STATUSES.includes(session.status)

  return (
    <div style={{
      borderRadius: 14, border: `1px solid ${CARD_BORDER}`, background: 'rgba(255,255,255,0.035)',
      overflow: 'hidden', ...GLASS,
    }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${CARD_BORDER}` }}>
        <Pill color={STATUS_COLOR[session.status]} label={STATUS_LABEL[session.status]} />
        <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: '#52525b' }}>
          {elapsed(session.started_at ?? session.created_at)}
        </span>
        <span style={{
          fontSize: 12, color: '#a1a1aa', flex: 1, minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {session.task}
        </span>
        {isActive && (
          <GhostButton label="Kill" color="#f87171" onClick={onKill} disabled={killing} busy={killing} />
        )}
      </div>

      {messages.length > 0 && (
        <div style={{ maxHeight: 280, overflowY: 'auto', padding: '4px 14px' }}>
          {messages.map((m) => <MessageRow key={m.id} m={m} />)}
        </div>
      )}

      {session.status === 'pushed' && session.final_commit_sha && (
        <div style={{ padding: '8px 14px', fontSize: 11, fontFamily: 'var(--font-mono)', color: '#34d399' }}>
          Pushed: {session.final_commit_sha.slice(0, 12)}
        </div>
      )}
    </div>
  )
}
