/**
 * One "still on it" message when a turn runs long, and nothing otherwise.
 *
 * WHY THIS EXISTS (2026-08-08)
 * The WhatsApp path sends exactly one message per inbound — the final
 * assistant turn's text. Intermediate turns are persisted for history but
 * never sent, so on a slow turn the operator gets silence. The codebase
 * already names that failure elsewhere: "no way to tell 'Caye is thinking'
 * from 'Caye is broken' from 'Caye ignored me.'"
 *
 * The obvious fix — send the model's narration too — is wrong. Measured on a
 * real lookup:
 *
 *   12:21:54.120  "Let me check the full contact record."
 *   12:21:54.174  "It's zanzi2go@gmail.com."
 *
 * 54ms apart. Two notifications in the same instant, the first of which
 * ("let me check the full contact record") carries no information. Turn
 * durations are bimodal: nearly all finish in a second or two, but a real
 * tail runs 18-63s (bulk lead drafting, send_outreach_batch). Only that tail
 * needs anything, and what it needs is a heartbeat, not narration.
 *
 * So: a fixed string, at most once, only after the turn has ALREADY proven
 * slow. Fast turns are untouched and stay one message.
 *
 * Meta bills per 24h conversation window rather than per message, so an extra
 * message inside an open window costs nothing. Notification fatigue is the
 * only real cost, and the delay gate is what removes it.
 */

/** How long a turn must run before it earns a heartbeat. Above the observed
 *  fast-turn range and below the 18s floor of the slow tail, so ordinary
 *  lookups never trigger it. */
export const SLOW_TURN_MS = 15_000

export interface SlowTurnOptions {
  delayMs?: number
  /**
   * Sends the heartbeat. Receives `stillRunning` — check it immediately
   * before dispatching, because the timer fires while the work is still in
   * flight but the send itself takes time, and a heartbeat that lands AFTER
   * the answer reads worse than no heartbeat at all.
   */
  onSlow: (stillRunning: () => boolean) => Promise<void>
}

/**
 * Run `work`, sending a heartbeat if it is still going after `delayMs`.
 *
 * The heartbeat is fire-and-forget: it must never delay the real answer, and
 * a failed heartbeat must never fail the turn. Errors are logged and
 * swallowed for that reason.
 */
export async function withSlowTurnHeartbeat<T>(
  work: () => Promise<T>,
  options: SlowTurnOptions
): Promise<T> {
  const delayMs = options.delayMs ?? SLOW_TURN_MS
  let running = true

  const timer = setTimeout(() => {
    if (!running) return
    void options.onSlow(() => running).catch((err) => {
      console.error('[slow-turn-heartbeat] heartbeat send failed:', err)
    })
  }, delayMs)

  try {
    return await work()
  } finally {
    running = false
    clearTimeout(timer)
  }
}
