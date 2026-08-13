'use client'

import { useState } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { FormattedReplyText } from '@/components/ui/FormattedReplyText'
import { formatDistanceToNow } from '@/lib/utils'
import { AQUA, TEXT, TEXT_QUIET } from '@/components/dashboard/surface'

export interface ThreadMessage {
  id: string
  sender_type: string
  content: string
  sent_at: string
  metadata?: { generated_by?: string; proposed_reply?: string; subject?: string } | null
  is_internal?: boolean
}

// Comfortable reading width, not "spans nearly the entire pane" — caps at
// 560px even on a wide thread column, same instinct as a text editor's
// line-length limit.
const MAX_WIDTH = 'min(560px, 78%)'

// Finds where a quoted reply chain or signature starts, so the visible
// message is the new content, not a wall of ">"-quoted history + a legal
// footer. Nothing is discarded — `trimmed` still holds the full original,
// just collapsed behind a toggle. Only applied to email (the channel this
// actually happens on).
function splitEmailContent(content: string): { main: string; trimmed: string | null } {
  const lines = content.split('\n')
  let boundary = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('>')) { boundary = i; break }
    if (/^on .{5,120} wrote:$/i.test(line)) { boundary = i; break }
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(line)) { boundary = i; break }
    if (/^--\s*$/.test(lines[i])) { boundary = i; break }
  }
  if (boundary <= 0) return { main: content, trimmed: null }
  const main = lines.slice(0, boundary).join('\n').trimEnd()
  const trimmed = lines.slice(boundary).join('\n').trim()
  if (!main || !trimmed) return { main: content, trimmed: null }
  return { main, trimmed }
}

function EmailBody({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const { main, trimmed } = splitEmailContent(content)
  return (
    <>
      <p style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', margin: 0 }}>{main}</p>
      {trimmed && (
        <>
          {expanded && (
            <p style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: '8px 0 0', color: TEXT_QUIET }}>
              {trimmed}
            </p>
          )}
          <button
            onClick={() => setExpanded((e) => !e)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, marginTop: 6, fontSize: 11.5, color: AQUA }}
          >
            {expanded ? 'Hide quoted content' : 'Show trimmed content'}
          </button>
        </>
      )}
    </>
  )
}

export default function Message({
  message, channelType, customerLabel, founderLabel,
}: {
  message: ThreadMessage
  channelType: string
  customerLabel: string
  founderLabel: string
}) {
  const m = message
  const isBusiness = m.sender_type === 'business'
  const isCaye = isBusiness && m.metadata?.generated_by === 'caye'
  const isEmail = channelType === 'email'
  const time = formatDistanceToNow(m.sent_at)

  if (isCaye) {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: MAX_WIDTH, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: AQUA }}>Caye</span>
          <span style={{ display: 'flex' }}><CayeMark size={12} /></span>
          <span style={{ fontSize: 10.5, color: TEXT_QUIET }}>{time}</span>
        </div>
        {isEmail ? <EmailBody content={m.content} /> : (
          <FormattedReplyText text={m.content} style={{ fontSize: 13.5, lineHeight: 1.5, color: TEXT, textAlign: 'left' }} />
        )}
      </div>
    )
  }

  if (isBusiness) {
    // The founder — the only human who sends from this founder-only Inbox
    // (owners/staff have their own locked dashboard, per the product's
    // channel model). Bubbled and aqua-tinted so it's unmistakably
    // distinct from Caye's unboxed replies just above/below it.
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: MAX_WIDTH, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: TEXT }}>{founderLabel}</span>
          <span style={{ fontSize: 10.5, color: TEXT_QUIET }}>{time}</span>
        </div>
        <div style={{ background: 'rgba(78,190,206,0.14)', borderRadius: '12px 3px 12px 12px', padding: '8px 12px' }}>
          {isEmail ? <EmailBody content={m.content} /> : (
            <p style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0, color: TEXT }}>{m.content}</p>
          )}
        </div>
      </div>
    )
  }

  // Customer
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: MAX_WIDTH, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: TEXT }}>{customerLabel}</span>
        <span style={{ fontSize: 10.5, color: TEXT_QUIET }}>{time}</span>
      </div>
      {isEmail && m.metadata?.subject && (
        <span style={{ fontSize: 11, color: TEXT_QUIET, fontStyle: 'italic' }}>{m.metadata.subject}</span>
      )}
      <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '3px 12px 12px 12px', padding: '8px 12px' }}>
        {isEmail ? <EmailBody content={m.content} /> : (
          <p style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0, color: TEXT }}>{m.content}</p>
        )}
      </div>
    </div>
  )
}
