'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWorkspace } from '@/lib/workspace-context'
import { getHeldConversations, resolveHeld, type HeldDetail } from '@/lib/data/mobile'
import MIcon from '../MIcon'
import MAvatar from '../MAvatar'
import ChannelPip from '../ChannelPip'

export default function HeldScreen({ onResolved }: { onResolved: () => void }) {
  const { workspace } = useWorkspace()
  const [held, setHeld] = useState<HeldDetail[] | null>(null)

  const load = useCallback(() => {
    getHeldConversations(workspace.id).then(setHeld)
  }, [workspace.id])

  useEffect(() => {
    load()
  }, [load])

  const handleResolved = () => {
    load()
    onResolved()
  }

  const calm = held !== null && held.length === 0

  return (
    <div className="m-screen" data-screen-label="Held">
      <div className="m-screen-head">
        <div className="eyebrow">
          <MIcon name="alert" size={11} />
          Needs review
        </div>
        <h1>
          {held === null
            ? 'Held conversations'
            : calm
              ? 'All clear'
              : `${held.length} conversation${held.length === 1 ? '' : 's'} held`}
        </h1>
        <div className="sub">
          {calm
            ? "Caye is handling everything on her own. You'll see a conversation here only when she needs a decision."
            : 'Caye paused these so you can decide. Review her note, then reply and resume her.'}
        </div>
      </div>

      {held === null ? (
        <div className="held-card">
          <div className="reason">
            <div className="txt">Loading…</div>
          </div>
        </div>
      ) : calm ? (
        <div className="held-calm">
          <div className="ico">
            <MIcon name="tick" size={28} />
          </div>
          <h2>Nothing held right now</h2>
          <p>Caye handled everything on her own. She&apos;ll ping you here the moment she needs you.</p>
        </div>
      ) : (
        held.map(h => <HeldCard key={h.id} held={h} onResolved={handleResolved} />)
      )}

      <div style={{ height: 16 }} />
    </div>
  )
}

function HeldCard({ held, onResolved }: { held: HeldDetail; onResolved: () => void }) {
  const [reply, setReply] = useState(held.proposedReply ?? '')
  const [busy, setBusy] = useState(false)

  const submit = async (withReply: boolean) => {
    setBusy(true)
    const { error } = await resolveHeld(held.id, withReply ? reply : '')
    setBusy(false)
    if (error) {
      console.error('[HeldScreen] resolve failed:', error)
      return
    }
    onResolved()
  }

  return (
    <div className="held-card">
      <div className="head">
        <MAvatar name={held.who} size={42} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nm">{held.who}</div>
          <div className="meta">
            <ChannelPip ch={held.channel} size="sm" />
            {held.channelName} · {held.time}
          </div>
        </div>
      </div>

      <div className="reason">
        <div style={{ flex: 1 }}>
          <span className="lbl">Why held</span>
          <span className="txt">{held.reason}</span>
        </div>
      </div>

      {held.transcript.length > 0 && (
        <div className="transcript">
          {held.transcript.map((m, i) => (
            <div key={i} className={'transcript-msg ' + (m.who === 'guest' ? 'guest' : 'caye')}>
              <span className="lbl">
                {m.who === 'guest' ? held.who.split(' ')[0] : m.who === 'caye' ? 'Caye' : 'You'}
              </span>
              {m.text}
            </div>
          ))}
        </div>
      )}

      {held.cayeNote && (
        <div className="draft">
          <div className="lbl">
            <span className="caye-pip" />
            Caye&apos;s note to you
          </div>
          <div className="txt">{held.cayeNote}</div>
        </div>
      )}

      {held.proposedReply && (
        <div className="draft-label" style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.04em',
          color: 'var(--tc-near-black, #0E1A1A)',
          opacity: 0.7,
          marginTop: 12,
          marginBottom: 6,
        }}>
          <span className="caye-pip" />
          Caye&apos;s draft — edit and send
        </div>
      )}

      <textarea
        className="held-reply-input"
        placeholder="Write your reply to the guest…"
        value={reply}
        onChange={e => setReply(e.target.value)}
        rows={3}
      />

      <div className="actions">
        <button className="btn-sec" disabled={busy} onClick={() => submit(false)}>
          Just resume Caye
        </button>
        <button
          className="btn-pri coral"
          disabled={busy || !reply.trim()}
          onClick={() => submit(true)}
        >
          <MIcon name="tick" size={14} /> {busy ? 'Saving…' : 'Send & resume'}
        </button>
      </div>
    </div>
  )
}
