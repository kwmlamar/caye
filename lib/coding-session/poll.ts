import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import { parseStreamJsonLines } from './parse-stream-json'
import { runGateAndPush } from './gate-and-push'
import { notifyFounderCodingSessionDone } from './notify'
import {
  getCodingSession,
  updateCodingSession,
  insertCodingSessionMessages,
  insertCodingSessionMessage,
  type CodingSessionRow,
} from './queries'

const OUTPUT_FILE = '.caye-output.jsonl'

async function killAndTeardown(session: CodingSessionRow, finalStatus: 'killed' | 'timed_out'): Promise<void> {
  try {
    const sandbox = await Sandbox.get({ name: session.sandbox_name! })
    if (session.cmd_id) {
      const cmd = await sandbox.getCommand(session.cmd_id)
      await cmd.kill('SIGKILL').catch(() => {})
    }
    await sandbox.stop().catch(() => {})
  } catch (err) {
    // Sandbox may already be gone (e.g. it hit its own timeout first) —
    // that's fine, we still want to record the terminal state below.
    console.error('[coding-session] teardown error:', err)
  }

  await insertCodingSessionMessage(
    session.id,
    'system',
    finalStatus === 'killed' ? 'Session killed by founder.' : 'Session timed out.'
  )
  await updateCodingSession(session.id, { status: finalStatus, finished_at: new Date().toISOString() })
  await notifyFounderCodingSessionDone({ ...session, status: finalStatus })
}

/** Advances new output for a single active session by one poll tick. Called per-session, per cron tick, from the coding-session-poll route. */
export async function pollCodingSession(sessionId: string): Promise<void> {
  const session = await getCodingSession(sessionId)
  if (!session) return
  if (!['booting', 'running', 'testing'].includes(session.status)) return
  if (session.status === 'booting') return // still inside the synchronous boot request

  if (session.kill_requested) {
    await killAndTeardown(session, 'killed')
    return
  }
  if (session.timeout_at && new Date(session.timeout_at).getTime() < Date.now()) {
    await killAndTeardown(session, 'timed_out')
    return
  }

  if (!session.sandbox_name || !session.cmd_id) return

  let sandbox
  try {
    sandbox = await Sandbox.get({ name: session.sandbox_name })
  } catch (err) {
    // Sandbox vanished unexpectedly (e.g. hit its own hard timeout).
    await insertCodingSessionMessage(session.id, 'error', `Lost sandbox: ${err instanceof Error ? err.message : String(err)}`)
    await updateCodingSession(session.id, { status: 'timed_out', finished_at: new Date().toISOString() })
    await notifyFounderCodingSessionDone({ ...session, status: 'timed_out' })
    return
  }

  // Pull new output since the last-consumed byte offset. tail -c +N reads
  // from byte N to end — the delta since our cursor.
  const tailResult = await sandbox.runCommand('tail', ['-c', `+${session.output_cursor + 1}`, OUTPUT_FILE])
  const raw = await tailResult.stdout()

  if (raw.length > 0) {
    // split('\n') on "...\n" ends with a trailing "" element; on "...partial"
    // (no trailing newline) the last element is an incomplete line. Either
    // way, dropping the last element leaves exactly the complete lines —
    // the incomplete tail (if any) is left unconsumed for the next tick.
    const endsWithNewline = raw.endsWith('\n')
    const parts = raw.split('\n')
    const completeLines = parts.slice(0, -1)
    const consumedText = endsWithNewline ? raw : completeLines.map((l) => l + '\n').join('')
    const consumedBytes = Buffer.byteLength(consumedText, 'utf8')

    if (completeLines.length > 0) {
      const rows = parseStreamJsonLines(completeLines)
      await insertCodingSessionMessages(session.id, rows)
    }
    if (consumedBytes > 0) {
      await updateCodingSession(session.id, { output_cursor: session.output_cursor + consumedBytes })
    }
  }

  await updateCodingSession(session.id, { last_polled_at: new Date().toISOString() })

  const cmd = await sandbox.getCommand(session.cmd_id)
  if (cmd.exitCode === null) return // still running, come back next tick

  // Claude Code CLI process has exited — says nothing about task success,
  // just that it stopped. Run the gate; it decides pushed vs. failed.
  await runGateAndPush(sandbox, session.id)
  const finalSession = await getCodingSession(session.id)
  await sandbox.stop().catch(() => {})
  if (finalSession) await notifyFounderCodingSessionDone(finalSession)
}
