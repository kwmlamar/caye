import 'server-only'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { BedrockConnection } from './types'

/**
 * The first and only write boundary from Caye into TropiTrack.
 *
 * This is deliberately a separate class from `SupabaseBedrockReadProvider`,
 * not additional methods on it. The read provider's value is that it
 * *cannot* mutate; adding write methods to it would spend that property
 * permanently. See `briefs/ods-crew-day-write-path.md` for the full design
 * contract this class implements.
 *
 * Exactly one capability: `insertTimeEntries`. No update, no delete, no
 * other table. Approving a timesheet (`approved_by` / `approved_at`) is a
 * separate authority and is out of scope for this class.
 */

/**
 * Insertable shape of a `time_entries` row, restricted to the columns this
 * write path is allowed to set. `company_id` is accepted here only because
 * it is a live NOT NULL column on the table -- `insertTimeEntries` always
 * overwrites it with the resolved `companyId` argument and never trusts the
 * value on the row itself.
 */
export interface BedrockTimeEntryInsert {
  worker_id: string
  project_id: string
  date: string
  start_time: string
  end_time: string
  break_duration_minutes: number
  regular_hours: number
  overtime_hours: number
  notes: string | null
  created_by: string
  company_id: string
}

export interface BedrockWriteRowFailure {
  /** Index into the `rows` array passed to `insertTimeEntries`. */
  index: number
  row: BedrockTimeEntryInsert
  error: string
}

export interface BedrockWriteResult {
  /**
   * True only when every row was inserted AND the audit_logs row was
   * written. A partial insert, or an insert that succeeded without a
   * corresponding audit row, is never reported as `ok: true` -- see
   * "Partial failure is reported precisely" in the design brief.
   */
  ok: boolean
  attemptedCount: number
  insertedCount: number
  insertedIds: string[]
  failedRows: BedrockWriteRowFailure[]
  auditLogWritten: boolean
  auditLogError: string | null
}

type SupabaseClientFactory = (connection: BedrockConnection) => SupabaseClient

function createRealClient(connection: BedrockConnection): SupabaseClient {
  return createClient(connection.supabaseUrl, connection.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export class BedrockWriteProvider {
  private readonly client: SupabaseClient
  private readonly clientFactory: SupabaseClientFactory

  constructor(connection: BedrockConnection, clientFactory: SupabaseClientFactory = createRealClient) {
    this.clientFactory = clientFactory
    this.client = this.createClient(connection)
  }

  private createClient(connection: BedrockConnection): SupabaseClient {
    return this.clientFactory(connection)
  }

  /**
   * Insert one or more `time_entries` rows for `companyId` and record a
   * single `audit_logs` row describing the attempt.
   *
   * - `companyId` is forced onto every row; whatever the caller put in
   *   `row.company_id` is discarded.
   * - Rows are inserted one at a time so that a failure on one row never
   *   blocks the others, and so the result can name exactly which rows
   *   landed and which did not.
   * - An empty `rows` array is a no-op: nothing is inserted and no audit
   *   row is written for zero attempted writes.
   * - Every non-empty attempt writes exactly one `audit_logs` row,
   *   including when every insert fails. If the audit write itself fails,
   *   that failure is returned on the result rather than swallowed.
   */
  async insertTimeEntries(companyId: string, rows: BedrockTimeEntryInsert[]): Promise<BedrockWriteResult> {
    if (rows.length === 0) {
      return {
        ok: true,
        attemptedCount: 0,
        insertedCount: 0,
        insertedIds: [],
        failedRows: [],
        auditLogWritten: false,
        auditLogError: null,
      }
    }

    const startedAt = Date.now()

    // Explicit field allowlist -- never a spread -- so an `approved_by` or
    // `approved_at` (or any other extra key) smuggled onto the caller's row
    // object cannot reach the insert, and so `company_id` is always the
    // resolved companyId regardless of what the caller supplied.
    const scopedRows: BedrockTimeEntryInsert[] = rows.map(row => ({
      worker_id: row.worker_id,
      project_id: row.project_id,
      date: row.date,
      start_time: row.start_time,
      end_time: row.end_time,
      break_duration_minutes: row.break_duration_minutes,
      regular_hours: row.regular_hours,
      overtime_hours: row.overtime_hours,
      notes: row.notes,
      created_by: row.created_by,
      company_id: companyId,
    }))

    const insertedIds: string[] = []
    const failedRows: BedrockWriteRowFailure[] = []

    for (let index = 0; index < scopedRows.length; index++) {
      const row = scopedRows[index]
      try {
        const { data, error } = await this.client.from('time_entries').insert(row).select('id').single()
        if (error) {
          failedRows.push({ index, row, error: error.message })
        } else {
          insertedIds.push((data as { id: string }).id)
        }
      } catch (err) {
        failedRows.push({ index, row, error: err instanceof Error ? err.message : String(err) })
      }
    }

    const durationMs = Date.now() - startedAt
    const attemptedCount = scopedRows.length
    const insertedCount = insertedIds.length
    const insertOk = failedRows.length === 0
    const errorMessage = insertOk
      ? null
      : `${failedRows.length} of ${attemptedCount} time entry insert(s) failed: ${failedRows
          .map(f => `row ${f.index} (${f.error})`)
          .join('; ')}`

    const auditOutcome = await this.writeAuditLog({
      companyId,
      status: insertOk ? 'ok' : 'error',
      input: { attemptedCount, rows: scopedRows },
      result: { insertedCount, insertedIds, failedCount: failedRows.length, failedRows },
      targetRowId: insertedIds.length === 1 ? insertedIds[0] : null,
      errorMessage,
      durationMs,
    })

    return {
      ok: insertOk && auditOutcome.written,
      attemptedCount,
      insertedCount,
      insertedIds,
      failedRows,
      auditLogWritten: auditOutcome.written,
      auditLogError: auditOutcome.error,
    }
  }

  private async writeAuditLog(params: {
    companyId: string
    status: 'ok' | 'error'
    input: unknown
    result: unknown
    targetRowId: string | null
    errorMessage: string | null
    durationMs: number
  }): Promise<{ written: boolean; error: string | null }> {
    try {
      const { error } = await this.client.from('audit_logs').insert({
        company_id: params.companyId,
        tool_name: 'insertTimeEntries',
        source: 'api',
        scope: 'write',
        tier: 'confirm',
        status: params.status,
        target_table: 'time_entries',
        target_row_id: params.targetRowId,
        input: params.input,
        result: params.result,
        error_message: params.errorMessage,
        duration_ms: params.durationMs,
      })
      if (error) return { written: false, error: error.message }
      return { written: true, error: null }
    } catch (err) {
      return { written: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
