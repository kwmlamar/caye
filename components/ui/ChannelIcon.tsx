import type { ChannelType } from '@/lib/types'

const CH_MAP: Record<ChannelType, { bg: string; label: string }> = {
  wa: { bg: '#22c55e', label: 'W' },
  ig: { bg: 'linear-gradient(135deg,#f59e0b,#ec4899,#8b5cf6)', label: 'IG' },
  fb: { bg: '#3b82f6', label: 'M' },
  em: { bg: 'var(--tc-ink)', label: '@' },
}

export default function ChannelIcon({ ch, size = 18 }: { ch: ChannelType; size?: number }) {
  const c = CH_MAP[ch]
  return (
    <span
      className="ch-ic"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, size * 0.28),
        background: c.bg,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(8, size * 0.5),
        fontWeight: 700,
        fontFamily: 'var(--font-sans)',
        flexShrink: 0,
      }}
    >
      {c.label}
    </span>
  )
}
