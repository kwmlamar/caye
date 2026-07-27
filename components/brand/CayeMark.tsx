type Variant = 'primary' | 'on-cream' | 'on-teal' | 'reverse' | 'mono'

export function CayeMark({
  size = 32,
  variant,
  className,
}: {
  size?: number
  variant?: Variant
  className?: string
}) {
  void variant // kept for call-site compatibility; the logo doesn't vary by surface
  return (
    <img
      src="/caye-logo.png"
      role="img"
      aria-label="Caye"
      className={className}
      width={size}
      height={size}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        objectFit: 'cover',
        flexShrink: 0,
      }}
    />
  )
}
