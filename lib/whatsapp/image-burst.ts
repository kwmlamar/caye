/**
 * Should Caye answer this inbound image, or stay quiet and let the burst
 * finish?
 *
 * Pure so it unit-tests without server-only deps — same pattern as
 * autosend-gate.ts. The DB read lives in the operator webhook.
 *
 * WHY THIS EXISTS (2026-08-09)
 * Mrs. Max sent eleven tour photos in thirty-nine seconds. Each one hit
 * handleImageInbound independently, so each one spun up a full back-office
 * agent turn and shipped its own WhatsApp reply:
 *
 *   "Got it — 3 photos total now. Still holding."
 *   "Got it — 5 photos total now. Still holding."
 *   "Got it — 8 photos total now, including this great group shot with Max."
 *   "Got it — 9 photos total now, great group selfie…"
 *   "Got it — 9 photos total now, looks like the group enjoying some food."
 *   "Got it — 11 photos total now, another great one at the Dolphin House."
 *
 * Eleven replies, eleven agent calls, and a running count that was wrong
 * twice (two nines, then a jump to eleven) because each turn was counting
 * from a sliding context window rather than from state. The last one had no
 * photo behind it at all.
 *
 * A person receiving photos doesn't acknowledge each one. They wait for the
 * batch to stop and then say "got them". So: acknowledge the first image of
 * a burst, then stay silent while the burst continues. The images are still
 * persisted and still reach the model — the next time the operator says
 * anything, the whole batch is in context.
 */

/** How long after an image another image still counts as the same burst. */
export const IMAGE_BURST_WINDOW_MS = 90_000

export interface BurstDecision {
  /** Run the agent and reply, or persist silently. */
  respond: boolean
  reason: string
}

export function decideImageBurst(args: {
  /** When the previous inbound image from this operator arrived, if any. */
  previousImageAt: Date | null
  /** When this image arrived. */
  now: Date
  /** A caption turns an image into a real question — always worth answering. */
  hasCaption: boolean
}): BurstDecision {
  const { previousImageAt, now, hasCaption } = args

  // A caption is the operator actually saying something ("send this one to
  // Jeff"). Never swallow that, burst or not.
  if (hasCaption) return { respond: true, reason: 'image carries a caption' }

  if (!previousImageAt) return { respond: true, reason: 'first image in burst' }

  const gapMs = now.getTime() - previousImageAt.getTime()
  if (gapMs > IMAGE_BURST_WINDOW_MS) {
    return { respond: true, reason: `new burst (${Math.round(gapMs / 1000)}s gap)` }
  }

  return { respond: false, reason: `continuing burst (${Math.round(gapMs / 1000)}s gap)` }
}
