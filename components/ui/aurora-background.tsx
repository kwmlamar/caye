'use client'

import { cn } from '@/lib/utils'
import React, { ReactNode } from 'react'

interface AuroraBackgroundProps extends React.HTMLProps<HTMLDivElement> {
  children: ReactNode
  // When true, masks the aurora to the top-right corner so the
  // content center stays clean white. Defaults to true.
  showRadialGradient?: boolean
}

export function AuroraBackground({
  className,
  children,
  showRadialGradient = true,
  ...props
}: AuroraBackgroundProps) {
  return (
    <div
      className={cn('relative w-full h-full bg-[#f5fbfa]', className)}
      {...props}
    >
      {/* Aurora layer — Caye teal bands, light mode only, no invert */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div
          className={cn(
            // White bands create the "venetian blind" that lets teal peek through
            '[--wb:repeating-linear-gradient(100deg,white_0%,white_7%,transparent_10%,transparent_12%,white_16%)]',
            // Caye teal aurora — monochromatic, brand-true
            '[--aurora:repeating-linear-gradient(100deg,#0FB5A1_10%,#7dd3ca_15%,#0d9488_20%,#ccfbf1_25%,#0FB5A1_30%)]',
            '[background-image:var(--wb),var(--aurora)]',
            '[background-size:300%,_200%]',
            '[background-position:50%_50%,50%_50%]',
            'blur-[10px]',
            // Animated ::after layer creates the flowing depth
            'after:content-[""] after:absolute after:inset-0',
            'after:[background-image:var(--wb),var(--aurora)]',
            'after:[background-size:200%,_100%]',
            'after:animate-aurora',
            'after:[background-attachment:fixed]',
            'after:mix-blend-overlay',
            'absolute -inset-[10px] opacity-45 will-change-transform',
            showRadialGradient &&
              '[mask-image:radial-gradient(ellipse_at_100%_0%,black_10%,transparent_70%)]'
          )}
        />
      </div>

      {children}
    </div>
  )
}
