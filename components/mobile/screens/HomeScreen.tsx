'use client'

import { useEffect, useState } from 'react'
import { useWorkspace } from '@/lib/workspace-context'
import { getMobileHome, type HomeSummary } from '@/lib/data/mobile'
import type { MobileTab } from '../MobileApp'
import MIcon from '../MIcon'
import MAvatar from '../MAvatar'
import ChannelPip from '../ChannelPip'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export default function HomeScreen({
  onTabChange,
}: {
  onTabChange: (t: MobileTab) => void
  onHeldChange: () => void
}) {
  const { workspace } = useWorkspace()
  const [data, setData] = useState<HomeSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const firstName =
    (workspace.full_name || workspace.business_name || '').trim().split(' ')[0] || 'there'

  useEffect(() => {
    let active = true
    getMobileHome(workspace.id)
      .then(d => active && setData(d))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [workspace.id])

  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  return (
    <div className="m-screen" data-screen-label="Home">
      <div className="hero-greet">
        <div>
          <h1>
            {greeting()}, {firstName}
          </h1>
          <div className="date">{todayLabel}</div>
        </div>
        <span className="hero-avatar">{firstName[0]?.toUpperCase() ?? 'C'}</span>
      </div>

      <div className="caye-card">
        <div className="row1">
          <div className="who">
            <span className="caye-mark" />
            <div>
              <div className="nm">Caye</div>
              <div className="st">
                <span className="pulse" />
                On duty
              </div>
            </div>
          </div>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v">{loading ? '–' : data?.handled ?? 0}</div>
            <div className="k">Handled</div>
          </div>
          <div className="stat held">
            <div className="v">{loading ? '–' : data?.held ?? 0}</div>
            <div className="k">Held</div>
          </div>
          <div className="stat">
            <div className="v">{loading ? '–' : data?.booked ?? 0}</div>
            <div className="k">Booked</div>
          </div>
        </div>
        <div className="foot">
          <span className="sparkle">✦</span>
          <span>
            {loading
              ? 'Checking in with Caye…'
              : data && data.handled > 0
                ? <>Caye handled <b style={{ color: '#fff' }}>{data.handled} message{data.handled === 1 ? '' : 's'}</b> on her own today.</>
                : 'Caye is watching every channel — nothing needed you yet today.'}
          </span>
        </div>
      </div>

      {data?.heldPreview && (
        <>
          <div className="m-section-label">
            <span>Needs your eye</span>
            <span className="right" style={{ cursor: 'pointer' }} onClick={() => onTabChange('held')}>
              View all →
            </span>
          </div>

          <div className="attn-card">
            <div className="attn-head">
              <span className="tag">
                <span className="pip" />
                Held for review
              </span>
              <span className="time">{data.heldPreview.time}</span>
            </div>
            <div className="attn-who">
              <MAvatar name={data.heldPreview.who} size={40} />
              <div className="attn-body">
                <div className="nm">{data.heldPreview.who}</div>
                <div className="reason">{data.heldPreview.reason}</div>
              </div>
            </div>
            <div className="attn-actions">
              <button className="btn-sec" onClick={() => onTabChange('held')}>
                Open thread
              </button>
              <button className="btn-pri coral" onClick={() => onTabChange('held')}>
                Review now
              </button>
            </div>
          </div>
        </>
      )}

      <div className="m-section-label">
        <span>Caye handled · today</span>
        <span className="right" style={{ cursor: 'pointer' }} onClick={() => onTabChange('activity')}>
          Full log →
        </span>
      </div>

      <div className="handled-list">
        {loading ? (
          <div className="handled-row">
            <div className="body">
              <div className="ax">Loading…</div>
            </div>
          </div>
        ) : data && data.handledToday.length > 0 ? (
          data.handledToday.map(a => (
            <div className="handled-row" key={a.id}>
              <ChannelPip ch={a.channel} />
              <div className="body">
                <div className="who">
                  {a.who}
                  <span className="caye-pip" title="Handled by Caye" />
                </div>
                <div className="ax">Replied — {a.summary.toLowerCase()}</div>
              </div>
              <span className="t">{a.time}</span>
            </div>
          ))
        ) : (
          <div className="handled-row">
            <div className="body">
              <div className="ax">Nothing handled yet today.</div>
            </div>
          </div>
        )}
      </div>

      <div style={{ height: 16 }} />
    </div>
  )
}
