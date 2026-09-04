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
 * Capabilities: `insertTimeEntries`, `insertInvoice`, `insertPayment`,
 * `insertReceipt`, and `uploadReceiptImage`. No update, no delete, on any
 * table or storage object. Approving a timesheet (`approved_by` /
 * `approved_at`) is a separate authority and is out of scope for this class.
 *
 * `uploadReceiptImage` is the one capability here that is not a table
 * insert, and it stays inside the same rule: it only ever ADDS an object,
 * never overwrites (`upsert: false`) and never removes one. It exists
 * because `receipts.image_url` is NOT NULL with no default -- a receipt row
 * physically cannot be written without an image already stored somewhere --
 * so storing the photo is not an optional extra, it is a precondition of
 * the insert. See `insertReceipt` for why the placeholder the existing rows
 * use was not an option.
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
/**
 * TropiTrack's `documents` bucket, verified live 2026-09-03: the only bucket
 * in that project, public, 10MB cap, and these exact mime types. Its own app
 * already writes receipt images under a `receipts/` prefix.
 *
 * Note `image/gif` is absent even though Caye can read one, and `image/heic`
 * is present even though the model cannot -- the two sets are not the same,
 * and a caller has to satisfy both.
 */
export const BEDROCK_DOCUMENTS_BUCKET = 'documents'
export const BEDROCK_RECEIPT_MAX_BYTES = 10 * 1024 * 1024
export const BEDROCK_RECEIPT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
  'image/heic',
  'image/heif',
])

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

/**
 * Insertable shape of a `receipts` row, restricted to the columns this write
 * path is allowed to set. Verified against the live table on 2026-09-03.
 *
 * `image_url` is NOT NULL with no default, so it is required here rather
 * than optional -- the schema itself refuses a receipt with no image.
 *
 * `status` is NOT NULL with a CHECK of ('pending','processed','failed') and
 * a default of 'pending'. It is deliberately NOT settable here: a receipt
 * Caye records is 'pending' by definition, because nothing has reconciled
 * it yet, and letting a caller declare it 'processed' would be Caye
 * asserting an outcome it has no evidence for.
 *
 * `project_id`, `vendor`, `receipt_date` and `total_amount` are all nullable
 * on the table, and that is used rather than worked around: a receipt whose
 * job nobody could name is recorded unattributed instead of guessed at, the
 * same restraint `log_invoice_sent` already shows for its own job link.
 */
export interface BedrockReceiptInsert {
  image_url: string
  project_id: string | null
  submitted_by: string | null
  vendor: string | null
  receipt_date: string | null
  total_amount: number | null
  notes: string | null
  company_id: string
}

/**
 * Insertable shape of a `receipt_line_items` row, restricted to the columns
 * this write path is allowed to set. Verified against the live table
 * 2026-09-04: `receipt_id` and `receipt_name` are NOT NULL; `material_id`,
 * `qty`, `unit`, `unit_cost`, `total_cost`, and `match_confidence` are all
 * nullable, so a line item with an unreadable price or quantity is still
 * insertable rather than blocked on a guess.
 *
 * `applied` is deliberately absent from this shape, the same way `status` is
 * absent from `BedrockReceiptInsert` -- it is NOT NULL with a default of
 * `false` on the live table, and whatever TropiTrack's own app uses it for
 * (a review or sync step this adapter has no visibility into), Caye never
 * asserts it. Every row this inserts leaves it at the default.
 */
export interface BedrockReceiptLineItemInsert {
  receipt_id: string
  material_id: string | null
  receipt_name: string
  qty: number | null
  unit: string | null
  unit_cost: number | null
  total_cost: number | null
  match_confidence: 'high' | 'medium' | 'low' | 'none' | null
}

/**
 * Insertable shape of a `materials` row, restricted to the columns this
 * write path is allowed to set. Verified against the live table 2026-09-04:
 * `id, division_code, division_name, category, name, unit, unit_cost` are
 * all NOT NULL with no default -- the table has no `company_id` column at
 * all (it is a single global cost catalog, not a per-tenant one), so unlike
 * every other insertable shape here there is no tenant column to force onto
 * the row.
 *
 * This is an INSERT only, by design and by construction: nothing in this
 * class ever updates an existing `materials` row, so a receipt can never
 * silently overwrite a catalog price it happens to also mention. See
 * `insertMaterial`.
 */
export interface BedrockMaterialInsert {
  id: string
  division_code: string
  division_name: string
  category: string
  name: string
  unit: string
  unit_cost: number
  supplier: string | null
  notes: string | null
}

export interface BedrockWriteRowFailure {
  /** Index into the `rows` array passed to `insertTimeEntries`/`insertReceiptLineItems`; always 0 for the single-row insertInvoice/insertPayment/insertReceipt/insertMaterial paths. */
  index: number
  row: BedrockTimeEntryInsert | BedrockInvoiceInsert | BedrockPaymentInsert | BedrockReceiptInsert | BedrockReceiptLineItemInsert | BedrockMaterialInsert
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
   * Store a receipt photo and return the URL that `insertReceipt` needs.
   *
   * WHY THIS EXISTS AT ALL
   *
   * `receipts.image_url` is NOT NULL with no default. A receipt row cannot
   * be written without one, so this is a precondition of the insert rather
   * than a convenience.
   *
   * WHY NOT THE PLACEHOLDER THE EXISTING ROWS USE
   *
   * All six receipts in the live table have `image_url` set to the literal
   * string `'uploaded'`. Writing that for a photo that was never uploaded
   * anywhere would be recording a claim with nothing behind it, which is the
   * one thing this system is built not to do. If the image cannot be stored,
   * the receipt is not written.
   *
   * WHERE IT GOES
   *
   * TropiTrack's own `documents` bucket, under the `receipts/` prefix its
   * app already uses. The bucket is public, which is TropiTrack's existing
   * choice for this bucket and not something this class changes -- callers
   * should know a receipt URL is not a secret. Allowed types there are
   * jpeg/jpg/png/webp/pdf/heic/heif with a 10MB cap; this refuses anything
   * else up front rather than letting storage reject it with a less useful
   * error.
   *
   * `upsert: false`, so this can only ever add an object. A name collision
   * fails loudly instead of overwriting somebody's receipt.
   */
  async uploadReceiptImage(
    companyId: string,
    params: { bytes: Uint8Array; mimeType: string; filename: string }
  ): Promise<{ ok: true; url: string; path: string } | { ok: false; error: string }> {
    if (!BEDROCK_RECEIPT_MIME_TYPES.has(params.mimeType)) {
      return {
        ok: false,
        error: `refused: ${params.mimeType} is not an accepted receipt image type (${[...BEDROCK_RECEIPT_MIME_TYPES].join(', ')})`,
      }
    }
    if (params.bytes.byteLength > BEDROCK_RECEIPT_MAX_BYTES) {
      return {
        ok: false,
        error: `refused: receipt image is ${params.bytes.byteLength} bytes, over the ${BEDROCK_RECEIPT_MAX_BYTES}-byte bucket limit`,
      }
    }

    // company_id in the path so one company's receipts can never collide
    // with another's, even though the bucket itself is not company-scoped.
    const path = `receipts/${companyId}/${params.filename}`
    const { error } = await this.client.storage
      .from(BEDROCK_DOCUMENTS_BUCKET)
      .upload(path, params.bytes, { contentType: params.mimeType, upsert: false })

    if (error) return { ok: false, error: `receipt image upload failed: ${error.message}` }

    const { data } = this.client.storage.from(BEDROCK_DOCUMENTS_BUCKET).getPublicUrl(path)
    if (!data?.publicUrl) {
      return { ok: false, error: 'receipt image uploaded but no public URL could be resolved' }
    }
    return { ok: true, url: data.publicUrl, path }
  }

  /**
   * Insert one `receipts` row and record a single `audit_logs` row
   * describing the attempt.
   *
   * `status` is left to the column default (`'pending'`) rather than set
   * here -- see `BedrockReceiptInsert`. `image_url` must already point at a
   * stored object; get one from `uploadReceiptImage` and do not invent a
   * value for it.
   */
  async insertReceipt(companyId: string, row: BedrockReceiptInsert): Promise<BedrockWriteResult> {
    const scopedRow: BedrockReceiptInsert = {
      image_url: row.image_url,
      project_id: row.project_id,
      submitted_by: row.submitted_by,
      vendor: row.vendor,
      receipt_date: row.receipt_date,
      total_amount: row.total_amount,
      notes: row.notes,
      company_id: companyId,
    }

    return this.insertSingleRowAndAudit({
      companyId,
      table: 'receipts',
      toolName: 'insertReceipt',
      scopedRow,
    })
  }

  /**
   * Insert one or more `receipt_line_items` rows and record a single
   * `audit_logs` row describing the attempt -- mirrors `insertTimeEntries`
   * exactly: rows are inserted one at a time so a failure on one line item
   * never blocks the others, and an empty array is a no-op.
   *
   * `receipt_id` is NOT trusted blindly, despite `receipt_line_items` having
   * no `company_id` column of its own to check it against directly: every
   * distinct `receipt_id` in the batch is verified to belong to `companyId`
   * (via `receiptBelongsToCompany`, mirroring `insertPayment`'s
   * `invoiceBelongsToCompany` check on `payments`) BEFORE anything is
   * written. Any unowned or nonexistent receipt id refuses the WHOLE batch
   * -- not just the offending rows -- the same fail-closed, all-or-nothing
   * shape `insertPayment` uses, because partially trusting a batch that
   * named a foreign receipt is exactly the kind of "safe by coincidence of
   * today's only caller" gap that stops being safe the moment a second
   * caller exists.
   *
   * Each entry also carries a `matchReason` -- why this line item did or
   * did not link to an existing `materials` row -- that is written into the
   * `audit_logs` row's `input` but never into `receipt_line_items` itself
   * (the table has no such column). This is what makes "why didn't this
   * line item link" queryable from `audit_logs` after the fact, instead of
   * visible only in the one WhatsApp turn that proposed it.
   */
  async insertReceiptLineItems(
    companyId: string,
    entries: Array<{ row: BedrockReceiptLineItemInsert; matchReason: string | null }>
  ): Promise<BedrockWriteResult> {
    if (entries.length === 0) {
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

    const scopedRows: BedrockReceiptLineItemInsert[] = entries.map(({ row }) => ({
      receipt_id: row.receipt_id,
      material_id: row.material_id,
      receipt_name: row.receipt_name,
      qty: row.qty,
      unit: row.unit,
      unit_cost: row.unit_cost,
      total_cost: row.total_cost,
      match_confidence: row.match_confidence,
    }))
    // Audit-only view of the same rows -- match_reason rides along here and
    // nowhere near the actual insert below.
    const auditRows = scopedRows.map((row, index) => ({ ...row, match_reason: entries[index].matchReason }))

    const receiptIds = [...new Set(scopedRows.map(r => r.receipt_id))]
    const unownedReceiptIds: string[] = []
    for (const receiptId of receiptIds) {
      if (!(await this.receiptBelongsToCompany(companyId, receiptId))) unownedReceiptIds.push(receiptId)
    }

    if (unownedReceiptIds.length > 0) {
      const durationMs = Date.now() - startedAt
      const errorMessage = `refused: receipt id(s) ${unownedReceiptIds.join(', ')} not found for company ${companyId} (nonexistent, or belong to a different company)`
      const failedRows: BedrockWriteRowFailure[] = scopedRows.map((row, index) => ({ index, row, error: errorMessage }))

      const auditOutcome = await this.writeAuditLog({
        companyId,
        toolName: 'insertReceiptLineItems',
        targetTable: 'receipt_line_items',
        status: 'denied',
        input: { attemptedCount: scopedRows.length, rows: auditRows },
        result: null,
        targetRowId: null,
        errorMessage,
        durationMs,
      })

      return {
        ok: false,
        attemptedCount: scopedRows.length,
        insertedCount: 0,
        insertedIds: [],
        failedRows,
        auditLogWritten: auditOutcome.written,
        auditLogError: auditOutcome.error,
      }
    }

    const insertedIds: string[] = []
    const failedRows: BedrockWriteRowFailure[] = []

    for (let index = 0; index < scopedRows.length; index++) {
      const row = scopedRows[index]
      try {
        const { data, error } = await this.client.from('receipt_line_items').insert(row).select('id').single()
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
      : `${failedRows.length} of ${attemptedCount} receipt line item insert(s) failed: ${failedRows
          .map(f => `row ${f.index} (${f.error})`)
          .join('; ')}`

    const auditOutcome = await this.writeAuditLog({
      companyId,
      toolName: 'insertReceiptLineItems',
      targetTable: 'receipt_line_items',
      status: insertOk ? 'ok' : 'error',
      input: { attemptedCount, rows: auditRows },
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
   * Insert one new `materials` row and record a single `audit_logs` row
   * describing the attempt. INSERT only -- there is no method on this class
   * that updates an existing materials row, which is what makes "a receipt
   * silently overwrote a catalog price" structurally impossible here rather
   * than merely discouraged. Callers decide whether a new row is warranted
   * (no confident existing match, and a price is actually known); this
   * method does not make that judgment, it only writes what it is given.
   *
   * `companyId` is accepted for audit-log tagging only, the same way
   * `insertPayment` accepts it despite `payments` also having no tenant
   * column -- it is never part of the row itself, because `materials` has no
   * `company_id` column to put it in.
   */
  async insertMaterial(companyId: string, row: BedrockMaterialInsert): Promise<BedrockWriteResult> {
    const scopedRow: BedrockMaterialInsert = {
      id: row.id,
      division_code: row.division_code,
      division_name: row.division_name,
      category: row.category,
      name: row.name,
      unit: row.unit,
      unit_cost: row.unit_cost,
      supplier: row.supplier,
      notes: row.notes,
    }

    return this.insertSingleRowAndAudit({
      companyId,
      table: 'materials',
      toolName: 'insertMaterial',
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

  /**
   * True only when a `receipts` row exists matching both `id` and
   * `company_id` -- the same shape as `invoiceBelongsToCompany`, used by
   * `insertReceiptLineItems` since `receipt_line_items` has no `company_id`
   * of its own to check directly. Any failure to confirm that -- not found,
   * wrong company, or a query error -- fails closed and returns false.
   */
  private async receiptBelongsToCompany(companyId: string, receiptId: string): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from('receipts')
        .select('id')
        .eq('id', receiptId)
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
    table: 'invoices' | 'payments' | 'receipts' | 'materials'
    toolName: 'insertInvoice' | 'insertPayment' | 'insertReceipt' | 'insertMaterial'
    scopedRow: BedrockInvoiceInsert | BedrockPaymentInsert | BedrockReceiptInsert | BedrockMaterialInsert
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
