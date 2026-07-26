import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { MessageKind } from './parse-stream-json'

export type CodingSessionStatus =
  | 'booting'
  | 'running'
  | 'testing'
  | 'pushed'
  | 'failed'
  | 'timed_out'
  | 'killed'

export interface CodingSessionRow {
  id: string
  task: string
  requested_by: string
  status: CodingSessionStatus
  sandbox_name: string | null
  cmd_id: string | null
  output_cursor: number
  base_commit_sha: string | null
  final_commit_sha: string | null
  gate_test_passed: boolean | null
  gate_build_passed: boolean | null
  gate_output: string | null
  kill_requested: boolean
  error: string | null
  created_at: string
  started_at: string | null
  timeout_at: string | null
  last_polled_at: string | null
  finished_at: string | null
}

/** The single most recent coding session, if any — used to resume showing in-flight/last-session state after reopening the panel. */
export async function getLatestCodingSession(): Promise<CodingSessionRow | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('caye_coding_sessions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as CodingSessionRow | null) ?? null
}

export async function getCodingSession(id: string): Promise<CodingSessionRow | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('caye_coding_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  return (data as CodingSessionRow | null) ?? null
}

export async function getActiveCodingSessionIds(): Promise<string[]> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('caye_coding_sessions')
    .select('id')
    .in('status', ['booting', 'running', 'testing'])
  return (data ?? []).map((r) => r.id as string)
}

export async function updateCodingSession(
  id: string,
  patch: Partial<Omit<CodingSessionRow, 'id' | 'created_at'>>
): Promise<void> {
  const supabase = createServiceClient()
  await supabase.from('caye_coding_sessions').update(patch).eq('id', id)
}

export async function getCodingSessionMessages(sessionId: string, limit = 500) {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('caye_coding_session_messages')
    .select('id, kind, body, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(limit)
  return data ?? []
}

export async function insertCodingSessionMessage(
  sessionId: string,
  kind: MessageKind,
  body: string,
  raw?: unknown
): Promise<void> {
  const supabase = createServiceClient()
  await supabase.from('caye_coding_session_messages').insert({
    session_id: sessionId,
    kind,
    body,
    raw: raw ?? null,
  })
}

export async function insertCodingSessionMessages(
  sessionId: string,
  rows: { kind: MessageKind; body: string; raw?: unknown }[]
): Promise<void> {
  if (rows.length === 0) return
  const supabase = createServiceClient()
  await supabase.from('caye_coding_session_messages').insert(
    rows.map((r) => ({ session_id: sessionId, kind: r.kind, body: r.body, raw: r.raw ?? null }))
  )
}
