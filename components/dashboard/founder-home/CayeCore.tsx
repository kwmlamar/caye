'use client'

import { CayeMark } from '@/components/brand/CayeMark'

/**
 * Caye's visual presence — the animated orb, generalized so the same
 * component can eventually live anywhere in the product (not just the
 * Command Center hero), per the "I eventually want this elsewhere" ask.
 *
 * States are a UI abstraction, not a promise the backend already emits
 * all six. Today only four are wired to something real (see FounderHome):
 *   - idle       default, nothing notable happening
 *   - working    a route fetch is actually in flight (revalidating/isPending)
 *   - attention  pending_escalation_count > 0 — something genuinely needs the founder
 *   - error      a connected channel actually needs reauth / is down
 * `thinking` and `speaking` have no real signal yet (would come from lifting
 * CayeDirectThread's `sending` state, or eventually a live-call runtime —
 * see voice-calling-roadmap.md, not started). The prop accepts them now so
 * nothing has to change here when that wiring exists.
 */
export type CayeState = 'idle' | 'working' | 'thinking' | 'speaking' | 'attention' | 'error'

const STATE_CONFIG: Record<CayeState, { color: string; ringMs: number; breatheMs: number; dim?: boolean; badge?: boolean }> = {
  idle: { color: '#4EBECE', ringMs: 3200, breatheMs: 3600 },
  working: { color: '#4EBECE', ringMs: 1800, breatheMs: 2200 },
  thinking: { color: '#4EBECE', ringMs: 1300, breatheMs: 1600 },
  speaking: { color: '#FFE4AF', ringMs: 1100, breatheMs: 1300 },
  attention: { color: '#FFE4AF', ringMs: 1600, breatheMs: 2000, badge: true },
  error: { color: '#fb7185', ringMs: 4500, breatheMs: 4500, dim: true },
}

export function CayeCore({ state = 'idle', size = 120 }: { state?: CayeState; size?: number }) {
  const cfg = STATE_CONFIG[state]
  const ringSize = Math.round(size * 0.78)
  const orbSize = Math.round(size * 0.5)
  const markSize = Math.round(orbSize * 0.56)
  const uid = `caye-core-${state}` // stable per-state class, keyframes shared across instances

  return (
    <div
      style={{
        position: 'relative', width: size, height: size, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <style>{`
        @keyframes caye-core-ring {
          0%   { transform: scale(0.6); opacity: 0.5; }
          100% { transform: scale(1.9); opacity: 0; }
        }
        @keyframes caye-core-breathe {
          0%, 100% { transform: scale(0.97); }
          50%      { transform: scale(1.04); }
        }
        @keyframes caye-core-badge-pulse {
          0%, 100% { opacity: 0.6; transform: scale(0.85); }
          50%      { opacity: 1; transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .${uid}-ring { animation: none !important; opacity: 0.3 !important; }
          .${uid}-breathe { animation: none !important; }
          .${uid}-badge { animation: none !important; }
        }
        @media (max-width: 480px) {
          .${uid}-ring { opacity: 0.35; }
        }
      `}</style>

      {!cfg.dim && (
        <>
          <span aria-hidden className={`${uid}-ring`} style={{
            position: 'absolute', width: ringSize, height: ringSize, borderRadius: '50%',
            border: `1.5px solid ${cfg.color}`,
            animation: `caye-core-ring ${cfg.ringMs}ms ease-out infinite`,
          }} />
          <span aria-hidden className={`${uid}-ring`} style={{
            position: 'absolute', width: ringSize, height: ringSize, borderRadius: '50%',
            border: `1.5px solid ${cfg.color}`,
            animation: `caye-core-ring ${cfg.ringMs}ms ease-out infinite`,
            animationDelay: `${cfg.ringMs / 2}ms`,
          }} />
        </>
      )}

      <div
        className={`${uid}-breathe`}
        style={{
          position: 'relative', width: orbSize, height: orbSize, borderRadius: '50%',
          background: 'radial-gradient(circle at 35% 30%, #0f2a33, #111113)',
          boxShadow: `0 0 ${Math.round(orbSize * 0.5)}px ${cfg.color}59`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: cfg.dim ? 0.72 : 1,
          animation: `caye-core-breathe ${cfg.breatheMs}ms ease-in-out infinite`,
        }}
      >
        <CayeMark size={markSize} />
      </div>

      {cfg.badge && (
        <span
          aria-hidden
          className={`${uid}-badge`}
          style={{
            position: 'absolute', top: Math.round(size * 0.12), right: Math.round(size * 0.14),
            width: Math.max(8, Math.round(size * 0.09)), height: Math.max(8, Math.round(size * 0.09)),
            borderRadius: '50%', background: cfg.color,
            boxShadow: `0 0 0 3px #111113`,
            animation: 'caye-core-badge-pulse 1.6s ease-in-out infinite',
          }}
        />
      )}
    </div>
  )
}
