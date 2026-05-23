'use client'

import { useState } from 'react'
import SaveBar from './SaveBar'
import Toggle from '@/components/ui/Toggle'
import type { NotificationPrefs } from '@/lib/types'

const ROWS: { k: keyof typeof INITIAL_PREFS; title: string; desc: string }[] = [
  { k: 'newMsg', title: 'New message', desc: 'A guest sent a new message that\'s waiting for you or Caye.' },
  { k: 'booking', title: 'Booking created', desc: 'A new tour booking landed — from any channel or your booking page.' },
  { k: 'cayeHold', title: 'Caye held for review', desc: 'Caye drafted a reply but held it for you (matched an escalation topic, or low confidence).' },
  { k: 'daily', title: 'Daily summary', desc: 'Email at 6:30pm with tomorrow\'s tours, today\'s bookings, and pending guests.' },
]

const INITIAL_PREFS = {
  newMsg:   { push: true,  email: false } satisfies NotificationPrefs,
  booking:  { push: true,  email: true  } satisfies NotificationPrefs,
  cayeHold: { push: true,  email: false } satisfies NotificationPrefs,
  daily:    { push: false, email: true  } satisfies NotificationPrefs,
}

export default function NotificationsPanel() {
  const [prefs, setPrefs] = useState(INITIAL_PREFS)
  const set = (k: keyof typeof prefs, ch: keyof NotificationPrefs, v: boolean) =>
    setPrefs({ ...prefs, [k]: { ...prefs[k], [ch]: v } })

  return (
    <div className="set-page">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Notifications</div>
          <h1>What you hear about</h1>
          <p className="set-page-desc">
            Pick which events ping your phone and which ones land in your inbox. Quiet hours from Caye AI apply here too.
          </p>
        </div>
      </header>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Alerts</h3>
            <div className="desc">Push notifications go to the Caye mobile app on Karenda&apos;s phone.</div>
          </div>
          <div style={{ display: 'flex', gap: 24, paddingRight: 4 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.14em', color: 'var(--tc-ink-faint)', fontWeight: 600, textTransform: 'uppercase', width: 50, textAlign: 'center' }}>Push</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.14em', color: 'var(--tc-ink-faint)', fontWeight: 600, textTransform: 'uppercase', width: 50, textAlign: 'center' }}>Email</span>
          </div>
        </div>
        <div className="s-card-body" style={{ gap: 0 }}>
          {ROWS.map((r) => (
            <div className="s-toggle-row" key={r.k}>
              <div className="tr-left">
                <div className="tr-title">{r.title}</div>
                <div className="tr-desc">{r.desc}</div>
              </div>
              <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
                <span style={{ width: 50, display: 'flex', justifyContent: 'center' }}>
                  <Toggle on={prefs[r.k].push} onChange={(v) => set(r.k, 'push', v)} />
                </span>
                <span style={{ width: 50, display: 'flex', justifyContent: 'center' }}>
                  <Toggle on={prefs[r.k].email} onChange={(v) => set(r.k, 'email', v)} />
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="s-card-foot">
          <span>Sending to <b style={{ color: 'var(--tc-ink)' }}>karenda@karendastours.com</b> and 1 device</span>
          <button className="btn-ghost sm">Manage devices</button>
        </div>
      </section>

      <SaveBar />
    </div>
  )
}
