import { CayeMark } from './CayeMark'

type Variant = 'primary' | 'on-cream' | 'on-teal' | 'reverse' | 'mono'

export function CayeLogo({ 
  size = 28,
  textClassName = 'text-[#0E1A1A]',
  markVariant = 'primary',
}: { 
  size?: number
  textClassName?: string
  markVariant?: Variant
}) {
  return (
    <div className="flex items-center gap-2">
      <CayeMark size={size} variant={markVariant} />
      <span
        className={`font-logo font-semibold tracking-tight sb-label ${textClassName}`}
        style={{ fontSize: size * 0.85 }}
      >
        caye
      </span>
    </div>
  )
}
