'use client'

import { CayeMark } from '@/components/brand/CayeMark'

// Same pulsing-orb pattern as the workspace cold-start screen
// (app/dashboard/[workspaceId]/layout.tsx) — reused here for every other
// "Loading…" moment in the founder console so the whole app speaks one
// loading language instead of plain gray text in some spots and a
// branded pulse in others.
export function CayeLoadingPulse({ label, size = 16 }: { label?: string; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <style>{`
        @keyframes caye-loading-pulse {
          0%, 100% { opacity: 0.5; transform: scale(0.94); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <span style={{ display: 'inline-flex', animation: 'caye-loading-pulse 1.4s ease-in-out infinite' }}>
        <CayeMark size={size} />
      </span>
      {label && (
        <span style={{ fontSize: 12.5, color: '#71717a', fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
          {label}
        </span>
      )}
    </span>
  )
}
