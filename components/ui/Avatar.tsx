const palettes = [
  'linear-gradient(140deg,#e85a3c,#c94824)',
  'linear-gradient(140deg,#1e6157,#2d8a7c)',
  'linear-gradient(140deg,#f4b942,#e88c3c)',
  'linear-gradient(140deg,#3b82f6,#6366f1)',
  'linear-gradient(140deg,#ec4899,#f59e0b)',
  'linear-gradient(140deg,#0b1419,#2d3a44)',
  'linear-gradient(140deg,#2d8a7c,#1e6157)',
  'linear-gradient(140deg,#c94824,#e85a3c)',
]

function hashIdx(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0
  return h % palettes.length
}

export default function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name.split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase()
  return (
    <span
      className="av"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: palettes[hashIdx(name)],
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
        fontSize: Math.max(10, size * 0.4),
        flexShrink: 0,
        letterSpacing: '-0.01em',
      }}
    >
      {initials}
    </span>
  )
}
