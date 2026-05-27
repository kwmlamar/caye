import Image from 'next/image'

type Variant = 'primary' | 'on-cream' | 'on-teal' | 'reverse' | 'mono'

const files: Record<Variant, string> = {
  'primary': '/brand/caye-mark.svg',
  'on-cream': '/brand/caye-mark-on-cream.svg',
  'on-teal': '/brand/caye-mark-primary-teal.svg',
  'reverse': '/brand/caye-mark-reverse.svg',
  'mono': '/brand/caye-mark-mono.svg',
}

export function CayeMark({
  size = 32,
  variant = 'primary',
  className,
}: {
  size?: number
  variant?: Variant
  className?: string
}) {
  return (
    <Image
      src={files[variant]}
      alt="Caye"
      width={size}
      height={size}
      className={className}
      priority
    />
  )
}
