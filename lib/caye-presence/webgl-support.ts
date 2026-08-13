// Cheap, synchronous WebGL capability check used to decide between the
// real R3F scene and CayePresenceFallback. Cached after first call since
// it can't change over a page's lifetime.

let cached: boolean | null = null

export function hasWebGL(): boolean {
  if (cached !== null) return cached
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false
  }
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    cached = !!gl
  } catch {
    cached = false
  }
  return cached
}
