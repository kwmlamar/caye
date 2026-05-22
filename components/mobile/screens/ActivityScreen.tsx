'use client'

import { useEffect, useState } from 'react'
import { useWorkspace } from '@/lib/workspace-context'
import { getActivityFeed, channelName, type ActivityItem } from '@/lib/data/mobile'
import MIcon from '../MIcon'
import ChannelPip from '../ChannelPip'

function ActivityRow({ a }: { a: ActivityItem }) {
  const icon =
    a.type === 'booked' ? <MIcon name="tick" size={14} /> :
    a.type === 'replied' ? <MIcon name="msg" size={14} /> :
    <MIcon name="flag" size={14} />

  return (
    <div className="activity-row">
      <span className={'activity-dot ' + a.type}>{icon}</span>
      <div className="activity-body">
        <div className="activity-line">
          <b>{a.who}</b> · {a.type === 'booked' ? `Booked ${a.what.toLowerCase()}` : a.what.toLowerCase()}
        </div>
        <div className="activity-meta">
          <ChannelPip ch={a.channel} size="sm" />
          {channelName(a.channel)}
          {a.detail ? ` · ${a.detail}` : ''} · {a.time}
        </div>
      </div>
    </div>
  )
}

export default function ActivityScreen() {
  const { workspace } = useWorkspace()
  const [feed, setFeed] = useState<{ today: ActivityItem[]; yesterday: ActivityItem[] } | null>(null)

  useEffect(() => {
    let active = true
    getActivityFeed(workspace.id).then(f => active && setFeed(f))
    return () => {
      active = false
    }
  }, [workspace.id])

  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayLabel = yesterday.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  const empty = feed !== null && feed.today.length === 0 && feed.yesterday.length === 0

  return (
    <div className="m-screen" data-screen-label="Activity">
      <div className="m-screen-head">
        <div className="eyebrow">
          <MIcon name="feed" size={11} />
          Activity
        </div>
        <h1>What Caye did</h1>
        <div className="sub">
          A read-only log of every action Caye took on your behalf — replies, bookings, and holds.
        </div>
      </div>

      {feed === null ? (
        <div className="activity-day">
          <div className="activity-list">
            <div className="activity-row">
              <div className="activity-body">
                <div className="activity-line">Loading…</div>
              </div>
            </div>
          </div>
        </div>
      ) : empty ? (
        <div className="held-calm">
          <div className="ico">
            <MIcon name="feed" size={26} />
          </div>
          <h2>No activity yet</h2>
          <p>Once Caye starts replying and booking, every action shows up here.</p>
        </div>
      ) : (
        <>
          {feed.today.length > 0 && (
            <div className="activity-day">
              <div className="activity-day-h">
                <span>Today · {todayLabel}</span>
                <span className="cnt">
                  {feed.today.length} action{feed.today.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="activity-list">
                {feed.today.map(a => (
                  <ActivityRow key={a.id} a={a} />
                ))}
              </div>
            </div>
          )}

          {feed.yesterday.length > 0 && (
            <div className="activity-day">
              <div className="activity-day-h">
                <span>Yesterday · {yesterdayLabel}</span>
                <span className="cnt">
                  {feed.yesterday.length} action{feed.yesterday.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="activity-list">
                {feed.yesterday.map(a => (
                  <ActivityRow key={a.id} a={a} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div style={{ height: 16 }} />
    </div>
  )
}
