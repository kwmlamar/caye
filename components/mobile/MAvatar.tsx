/** Initials avatar with a deterministic gradient, from the mobile design. */

const PALETTES = [
  'linear-gradient(140deg, #e85a3c, #c94824)',
  'linear-gradient(140deg, #1d6b5e, #134a40)',
  'linear-gradient(140deg, #f0b942, #ad7e1a)',
  'linear-gradient(140deg, #6db5b0, #1d6b5e)',
  'linear-gradient(140deg, #c94824, #e85a3c)',
  'linear-gradient(140deg, #0d1d24, #2d3a44)',
]

export default function MAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name
    .split(' ')
    .map(x => x[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0

  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: PALETTES[h % PALETTES.length],
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
        fontSize: Math.max(10, size * 0.38),
        flexShrink: 0,
        letterSpacing: '-0.01em',
      }}
    >
      {initials}
    </span>
  )
}
