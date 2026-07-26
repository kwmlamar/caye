import 'server-only'
import { updateCodingSession } from './queries'

/**
 * Marks a session for teardown. Actual sandbox kill + stop happens on the
 * next poll tick (poll.ts) — keeps this route trivially fast and means
 * there's only one place that knows how to tear a sandbox down.
 */
export async function requestKillCodingSession(sessionId: string): Promise<void> {
  await updateCodingSession(sessionId, { kill_requested: true })
}
