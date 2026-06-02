'use client'

import React from 'react'

interface FeatureSectionProps {
  eyebrow: string
  heading: string
  /** Italic-accent fragment of the heading, in caribbean-teal. Optional. */
  accent?: string
  body: string
  children: React.ReactNode
  reverse?: boolean
}

export default function FeatureSection({
  eyebrow,
  heading,
  accent,
  body,
  children,
  reverse = false,
}: FeatureSectionProps) {
  return (
    <section className="py-24 md:py-32 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 md:px-12">
        <div className={`grid grid-cols-1 lg:grid-cols-2 gap-14 lg:gap-24 items-center ${reverse ? 'lg:flex-row-reverse' : ''}`}>

          {/* Copy Column */}
          <div className={`space-y-7 max-w-xl ${reverse ? 'lg:order-2' : 'lg:order-1'}`}>
            <div className="font-mono text-[10.5px] font-semibold tracking-[0.22em] text-near-black/45 uppercase flex items-center gap-2.5">
              <span className="w-1 h-1 rounded-full bg-caribbean-teal" />
              {eyebrow}
            </div>

            <h2 className="font-instrument text-[2.25rem] sm:text-[2.75rem] lg:text-[3.25rem] text-near-black tracking-[-0.018em] leading-[1.05]">
              {heading}
              {accent && (
                <>
                  {' '}
                  <span className="italic text-caribbean-teal-deep">{accent}</span>
                </>
              )}
            </h2>

            <p className="text-near-black/70 text-[17px] leading-relaxed font-sans">
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
