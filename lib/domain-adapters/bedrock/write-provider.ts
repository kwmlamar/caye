import 'server-only'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { BedrockConnection } from './types'

/**
 * The first and only write boundary from Caye into TropiTrack.
 *
 * This is deliberately a separate class from `SupabaseBedrockReadProvider`,
 * not additional methods on it. The read provider's value is that it
 * *cannot* mutate; adding write methods to it would spend that property
 * permanently. See `briefs/ods-crew-day-write-path.md` for the crew-day
 * write contract and `briefs/ods-receivables-loop.md` for the receivables
 * contract this class also implements.
 *
 * Three capabilities: `insertTimeEntries`, `insertInvoice`, `insertPayment`.
 * No update, no delete, on any table. Approving a timesheet (`approved_by`
 * / `approved_at`) is a separate authority and is out of scope for this
 * class.
 *
 * `insertPayment` in particular stays insert-only on purpose. TropiTrack
 * runs a live trigger, `after_payment_insert`, calling
 * `update_invoice_on_payment()`, which recalculates the invoice's
 * `amount_paid`, `balance_due` and status the moment a payment row lands.
 * Recording a payment therefore never needs this class to update
 * `invoices` -- the database already keeps that derived state in sync.
 * Do not "helpfully" add an update path here to keep totals in sync; that
 * would race the trigger and duplicate logic that already lives, and is
 * tested, at the database layer.
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

/**
 * Insertable shape of an `invoices` row, restricted to the columns this
 * write path is allowed to set. `company_id` is accepted here only because
 * it is a live NOT NULL column on the table -- `insertInvoice` always
 * overwrites it with the resolved `companyId` argument and never trusts the
 * value on the row itself.
 */
export interface BedrockInvoiceInsert {
  invoice_number: string
  client_name: string
  invoice_type: string
  status: string
  issue_date: string
  due_date: string
  created_by: string
  client_id: string | null
  project_id: string | null
  estimate_id: string | null
  subtotal: number | null
  tax_rate: number | null
  tax_amount: number | null
  total_amount: number | null
  notes: string | null
  terms: string | null
  sent_at: string | null
  company_id: string
}

/**
 * Insertable shape of a `payments` row, restricted to the columns this
 * write path is allowed to set.
 *
 * There is deliberately no `company_id` here -- the live `payments` table
 * has no tenant column. `insertPayment` verifies tenancy indirectly, by
 * confirming `invoice_id` names an invoice that belongs to the resolved
 * `companyId`, before it writes anything.
 */
export interface BedrockPaymentInsert {
  invoice_id: string
  payment_date: string
  amount: number
  payment_method: string
  received_by: string
  reference_number: string | null
  notes: string | null
}

export interface BedrockWriteRowFailure {
  /** Index into the `rows` array passed to `insertTimeEntries`; always 0 for the single-row insertInvoice/insertPayment paths. */
  index: number
  row: BedrockTimeEntryInsert | BedrockInvoiceInsert | BedrockPaymentInsert
  error: string
}

export interface BedrockWriteResult {
  /**
   * True only when the row (or every row, for `insertTimeEntries`) was
   * inserted AND the audit_logs row was written. A partial insert, an
   * insert that succeeded without a corresponding audit row, or a refused
   * cross-tenant write is never reported as `ok: true` -- see "Partial
   * failure is reported precisely" in the design brief.
   */
  ok: boolean
  attemptedCount: number
  insertedCount: number
  insertedIds: string[]
  failedRows: BedrockWriteRowFailure[]
  auditLogWritten: boolean
  auditLogError: string | null
}

type AuditStatus = 'ok' | 'error' | 'denied'

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
      toolName: 'insertTimeEntries',
      targetTable: 'time_entries',
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

  /**
   * Insert one `invoices` row for `companyId` and record a single
   * `audit_logs` row describing the attempt.
   *
   * `companyId` is forced onto the row via an explicit field allowlist,
   * never a spread; whatever the caller put in `row.company_id` is
   * discarded.
   */
  async insertInvoice(companyId: string, row: BedrockInvoiceInsert): Promise<BedrockWriteResult> {
    const scopedRow: BedrockInvoiceInsert = {
      invoice_number: row.invoice_number,
      client_name: row.client_name,
      invoice_type: row.invoice_type,
      status: row.status,
      issue_date: row.issue_date,
      due_date: row.due_date,
      created_by: row.created_by,
      client_id: row.client_id,
      project_id: row.project_id,
      estimate_id: row.estimate_id,
      subtotal: row.subtotal,
      tax_rate: row.tax_rate,
      tax_amount: row.tax_amount,
      total_amount: row.total_amount,
      notes: row.notes,
      terms: row.terms,
      sent_at: row.sent_at,
      company_id: companyId,
    }

    return this.insertSingleRowAndAudit({
      companyId,
      table: 'invoices',
      toolName: 'insertInvoice',
      scopedRow,
    })
  }

  /**
   * Insert one `payments` row and record a single `audit_logs` row
   * describing the attempt.
   *
   * `payments` carries no `company_id` column, so before writing anything
   * this verifies -- through the same client this class already holds --
   * that `row.invoice_id` names an invoice belonging to `companyId` (a
   * lookup scoped by `id` AND `company_id` together). An invoice that does
   * not exist, or that belongs to a different company, is refused rather
   * than written: the refusal is itself audited with `status: 'denied'`,
   * because an attempted cross-tenant write is exactly the kind of event
   * that record exists for.
   *
   * See the class-level comment for why this never updates `invoices` to
   * keep totals in sync -- the `after_payment_insert` trigger already does
   * that in the database.
   */
  async insertPayment(companyId: string, row: BedrockPaymentInsert): Promise<BedrockWriteResult> {
    const scopedRow: BedrockPaymentInsert = {
      invoice_id: row.invoice_id,
      payment_date: row.payment_date,
      amount: row.amount,
      payment_method: row.payment_method,
      received_by: row.received_by,
      reference_number: row.reference_number,
      notes: row.notes,
    }

    const startedAt = Date.now()
    const owned = await this.invoiceBelongsToCompany(companyId, scopedRow.invoice_id)

    if (!owned) {
      const durationMs = Date.now() - startedAt
      const errorMessage = `refused: invoice ${scopedRow.invoice_id} was not found for company ${companyId} (nonexistent, or belongs to a different company)`
      const auditOutcome = await this.writeAuditLog({
        companyId,
        toolName: 'insertPayment',
        targetTable: 'payments',
        status: 'denied',
        input: { row: scopedRow },
        result: null,
        targetRowId: null,
        errorMessage,
        durationMs,
      })

      return {
        ok: false,
        attemptedCount: 1,
        insertedCount: 0,
        insertedIds: [],
        failedRows: [{ index: 0, row: scopedRow, error: errorMessage }],
        auditLogWritten: auditOutcome.written,
        auditLogError: auditOutcome.error,
      }
    }

    return this.insertSingleRowAndAudit({
      companyId,
      table: 'payments',
      toolName: 'insertPayment',
      scopedRow,
    })
  }

  /**
   * True only when an `invoices` row exists matching both `id` and
   * `company_id`. Any failure to confirm that -- not found, wrong company,
   * or a query error -- fails closed and returns false, so a payment is
   * never written on an ambiguous ownership check.
   */
  private async invoiceBelongsToCompany(companyId: string, invoiceId: string): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from('invoices')
        .select('id')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .maybeSingle()
      if (error) return false
      return data != null
    } catch {
      return false
    }
  }

  private async insertSingleRowAndAudit(params: {
    companyId: string
    table: 'invoices' | 'payments'
    toolName: 'insertInvoice' | 'insertPayment'
    scopedRow: BedrockInvoiceInsert | BedrockPaymentInsert
  }): Promise<BedrockWriteResult> {
    const { companyId, table, toolName, scopedRow } = params
    const startedAt = Date.now()

    let insertedId: string | null = null
    let failure: BedrockWriteRowFailure | null = null

    try {
      // Cast at the client boundary only: `scopedRow` is a union of two
      // distinct insertable shapes, and supabase-js's per-overload excess-
      // property check does not accept a union argument. The row itself is
      // still built above via an explicit field allowlist, so this cast
      // widens nothing that reaches the database.
      const { data, error } = await this.client
        .from(table)
        .insert(scopedRow as unknown as Record<string, unknown>)
        .select('id')
        .single()
      if (error) {
        failure = { index: 0, row: scopedRow, error: error.message }
      } else {
        insertedId = (data as { id: string }).id
      }
    } catch (err) {
      failure = { index: 0, row: scopedRow, error: err instanceof Error ? err.message : String(err) }
    }

    const durationMs = Date.now() - startedAt
    const insertOk = failure === null

    const auditOutcome = await this.writeAuditLog({
      companyId,
      toolName,
      targetTable: table,
      status: insertOk ? 'ok' : 'error',
      input: { row: scopedRow },
      result: insertOk ? { insertedId } : { failure },
      targetRowId: insertedId,
      errorMessage: insertOk ? null : failure!.error,
      durationMs,
    })

    return {
      ok: insertOk && auditOutcome.written,
      attemptedCount: 1,
      insertedCount: insertOk ? 1 : 0,
      insertedIds: insertedId ? [insertedId] : [],
      failedRows: failure ? [failure] : [],
      auditLogWritten: auditOutcome.written,
      auditLogError: auditOutcome.error,
    }
  }

  private async writeAuditLog(params: {
    companyId: string
    toolName: string
    targetTable: string
    status: AuditStatus
    input: unknown
    result: unknown
    targetRowId: string | null
    errorMessage: string | null
    durationMs: number
  }): Promise<{ written: boolean; error: string | null }> {
    try {
      const { error } = await this.client.from('audit_logs').insert({
        company_id: params.companyId,
        tool_name: params.toolName,
        source: 'api',
        scope: 'write',
        tier: 'confirm',
        status: params.status,
        target_table: params.targetTable,
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
