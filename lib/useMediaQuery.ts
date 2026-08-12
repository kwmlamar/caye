'use client'

import { useState, useEffect } from 'react'

// Minimal matchMedia hook — used where a component prop (not just CSS)
// needs to react to viewport size, e.g. CayeCore's orb shrinking on
// narrow screens rather than just reflowing.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(query)
    setMatches(mql.matches)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
