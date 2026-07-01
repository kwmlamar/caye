type Variant = 'primary' | 'on-cream' | 'on-teal' | 'reverse' | 'mono'

// Landing-page hero mesh-gradient palette (PALETTE_DEEP in app/page.tsx) —
// the mark is now a plain orb carrying the same colors instead of a face/
// wave icon, so it doesn't read as an anthropomorphic mark. Layered soft
// radial blobs (not conic-gradient) so it blends like the real mesh
// gradient instead of reading as a hard-edged pie chart.
export const ORB_GRADIENT =
  'radial-gradient(circle at 22% 22%, rgba(255,255,255,0.6), transparent 38%), ' +
  'radial-gradient(circle at 18% 20%, #7DC9CB 0%, transparent 48%), ' +
  'radial-gradient(circle at 88% 15%, #FFD68F 0%, transparent 52%), ' +
  'radial-gradient(circle at 82% 88%, #00778B 0%, transparent 58%), ' +
  'radial-gradient(circle at 12% 85%, #A8DCC0 0%, transparent 52%), ' +
  '#F5E8D0'

export function CayeMark({
  size = 32,
  variant,
  className,
}: {
  size?: number
  variant?: Variant
  className?: string
}) {
  void variant // kept for call-site compatibility; the orb doesn't vary by surface
  return (
    <span
      role="img"
      aria-label="Caye"
      className={className}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: ORB_GRADIENT,
        flexShrink: 0,
      }}
    />
  )
}
