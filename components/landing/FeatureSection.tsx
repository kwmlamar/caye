'use client'

import React from 'react'

interface FeatureSectionProps {
  eyebrow: string
  heading: string
  body: string
  children: React.ReactNode
  reverse?: boolean
}

export default function FeatureSection({
  eyebrow,
  heading,
  body,
  children,
  reverse = false,
}: FeatureSectionProps) {
  return (
    <section className="py-20 md:py-28 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 md:px-12">
        <div className={`grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center ${reverse ? 'lg:flex-row-reverse' : ''}`}>
          
          {/* Copy Column */}
          <div className={`space-y-6 max-w-xl ${reverse ? 'lg:order-2' : 'lg:order-1'}`}>
            <div className="font-mono text-xs font-semibold tracking-widest text-near-black/50 uppercase flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-caribbean-teal" />
              {eyebrow}
            </div>
            
            <h2 className="text-3xl md:text-4xl lg:text-[44px] font-semibold text-near-black tracking-tight leading-[1.1]">
              {heading}
            </h2>
            
            <p className="text-near-black/75 text-[17px] leading-relaxed font-sans">
              {body}
            </p>
          </div>

          {/* Graphic/Mockup Column */}
          <div className={`flex justify-center w-full ${reverse ? 'lg:order-1' : 'lg:order-2'}`}>
            <div className="w-full max-w-xl">
              {children}
            </div>
          </div>

        </div>
      </div>
    </section>
  )
}
