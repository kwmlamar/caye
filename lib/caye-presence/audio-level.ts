// Pure math for turning raw analyser bytes into a smooth 0..1 "how loud is
// Caye right now" signal. Kept framework-free (no AudioContext, no React) so
// it's cheap to unit test and safe to call every animation frame without
// allocating.

/** RMS of a Uint8Array of frequency-domain bytes (0..255), normalized to 0..1.
 *  RMS instead of a simple average because speech has short loud syllables
 *  against a lot of near-silence — averaging would wash those peaks out. */
export function computeLevel(bytes: Uint8Array<ArrayBufferLike>): number {
  if (bytes.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < bytes.length; i++) {
    const normalized = bytes[i] / 255
    sumSquares += normalized * normalized
  }
  return Math.sqrt(sumSquares / bytes.length)
}

/** Asymmetric exponential smoothing: rises fast (attack) so onsets feel
 *  immediate, falls slower (release) so the visual doesn't chatter between
 *  syllables and eases out instead of snapping to zero when speech stops.
 *  `attackPerSec`/`releasePerSec` are rates, not durations — higher = snappier. */
export function smoothLevel(
  previous: number,
  target: number,
  dtSeconds: number,
  attackPerSec = 18,
  releasePerSec = 6
): number {
  const rate = target > previous ? attackPerSec : releasePerSec
  const t = 1 - Math.exp(-rate * Math.max(dtSeconds, 0))
  return previous + (target - previous) * t
}
