'use client'

import { useState } from 'react'
import { useFounderIdentity } from '@/lib/useFounderIdentity'
import { signOut } from '@/lib/supabase'

// Bottom-of-rail identity chip. Only founders ever reach this component
// (the route itself is founder-gated — see lib/founder.ts), so "Founder"
// is a safe, real label rather than a lookup. Name/initial come from the
// same auth session everything else here reads.
export default function FounderProfile() {
  const { firstName, email } = useFounderIdentity()
  const [hover, setHover] = useState(false)
  const label = firstName ?? email ?? 'Founder'
  const initial = label.slice(0, 1).toUpperCase()

  return (
    <button
      onClick={() => signOut()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={email ? `Signed in as ${email} — click to sign out` : 'Sign out'}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
        border: 'none', cursor: 'pointer',
        background: hover ? 'rgba(78,190,206,0.16)' : 'rgba(255,255,255,0.045)',
        color: hover ? '#4EBECE' : '#a1a1aa',
        fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)',
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
    >
      {initial}
    </button>
  )
}
