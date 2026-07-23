'use client'

import { useState, type CSSProperties } from 'react'

// Shared badge/button primitives for the dark founder console
// (FounderHome and everything it renders: ContactsPanel,
// GlobalPerformance, ChannelsCard, AdminShell, CayeDirect). Each of
// those files used to hand-roll its own "StatusPill"/"StatusChip" —
// colored text on a tinted, bordered background — which read as loud,
// boxy badges next to the console's otherwise quiet, borderless cards.
// This replaces that pattern everywhere: a status is a dot + colored
// mono-caps text, nothing boxed; an action is quiet until hovered,
// never a filled or outlined button by default.

export function Pill({ color, label, dot = true }: { color: string; label: string; dot?: boolean }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
      letterSpacing: '0.04em', color, display: 'inline-flex', alignItems: 'center', gap: 5,
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      {dot && <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 }} />}
      {label}
    </span>
  )
}

interface GhostButtonProps {
  label: string
  color: string
  onClick?: () => void
  disabled?: boolean
  busy?: boolean
  href?: string
  title?: string
}

// Quiet text action — Connect/Disconnect/Pause/Resume/Reconnect/etc.
// Transparent until hovered, then a faint tint of its own color; never
// a border. `href` renders an <a> (for redirect-based OAuth connects),
// otherwise a <button>.
export function GhostButton({ label, color, onClick, disabled, busy, href, title }: GhostButtonProps) {
  const [hover, setHover] = useState(false)
  const style: CSSProperties = {
    fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
    letterSpacing: '0.04em', padding: '4px 9px', borderRadius: 7,
    color, background: hover && !disabled ? `${color}17` : 'transparent',
    border: 'none', cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1, flexShrink: 0, textDecoration: 'none',
    display: 'inline-flex', alignItems: 'center', lineHeight: 1,
    transition: 'background 0.15s ease',
  }
  const handlers = { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) }
  const content = busy ? '···' : label
  if (href) {
    return <a href={href} title={title} style={style} {...handlers}>{content}</a>
  }
  return <button type="button" title={title} onClick={onClick} disabled={disabled} style={style} {...handlers}>{content}</button>
}
