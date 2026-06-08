'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface AnimatedAIChatBackgroundProps {
  children: React.ReactNode
  className?: string
}

/**
 * Wraps Caye's empty-state content with an animated ambient background:
 * soft pulsing teal blobs, staggered entry animation, and a mouse-tracking
 * teal glow that appears whenever any input inside the container is focused.
 */
export function AnimatedAIChatBackground({
  children,
  className,
}: AnimatedAIChatBackgroundProps) {
  const [inputFocused, setInputFocused] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent) => setMousePos({ x: e.clientX, y: e.clientY })
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onIn = () => setInputFocused(true)
    const onOut = () => setInputFocused(false)
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
    }
  }, [])

  return (
    <div ref={containerRef} className={cn('relative w-full bg-[#f5fbfa]', className)}>
      {/* Ambient teal blobs */}
      <div
        className="absolute inset-0 overflow-hidden pointer-events-none"
        aria-hidden="true"
      >
        <div
          className="absolute top-0 left-1/4 w-[28rem] h-[28rem] rounded-full bg-[#0FB5A1] opacity-[0.07] blur-[128px] animate-pulse"
        />
        <div
          className="absolute bottom-0 right-1/4 w-[28rem] h-[28rem] rounded-full bg-teal-300 opacity-[0.07] blur-[128px] animate-pulse"
          style={{ animationDelay: '700ms' }}
        />
        <div
          className="absolute top-1/3 right-1/3 w-64 h-64 rounded-full bg-emerald-200 opacity-[0.09] blur-[96px] animate-pulse"
          style={{ animationDelay: '1200ms' }}
        />
      </div>

      {/* Staggered entry for content */}
      <motion.div
        className="relative z-10 w-full h-full"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.25, 0.1, 0.25, 1] }}
      >
        {children}
      </motion.div>

      {/* Mouse-tracking teal glow — only while an input is focused */}
      {inputFocused && (
        <motion.div
          className="fixed w-[38rem] h-[38rem] rounded-full pointer-events-none z-0 bg-[#0FB5A1] opacity-[0.04] blur-[96px]"
          animate={{
            x: mousePos.x - 304,
            y: mousePos.y - 304,
          }}
          transition={{
            type: 'spring',
            damping: 28,
            stiffness: 140,
            mass: 0.5,
          }}
        />
      )}
    </div>
  )
}
