import 'server-only'

import {
  createBedrockAdapter,
  createBedrockWriteProvider,
  BedrockConnectionMissingError,
} from '@/lib/domain-adapters/bedrock'
import { resolveJob } from '../read/find-job'
import type { Tool } from '../types'

/**
 * Record that an invoice went out.
 *
 * WHAT THIS FIXES
 *
 * ODS's audit found an entire completed job -- Sundancer, $5,682.81 -- absent
 * from both the estimate and invoice registers, and three real sent invoices
 * totalling $7,923.45 that appear in no register at all. It also found eight
 * simultaneous numbering schemes.
 *
 * And the failure that matters most: Sundancer's project register, written on
 * the same day the final invoice was sent, says it was "drafted... not yet
 * sent". The covering email said the invoice would follow "separately" while
 * attaching it, and the register copied the note rather than the fact. Anyone
 * acting on that record would have re-sent an invoice the client already held.
 *
 * A recorded `sent_at`, written at the moment of sending, makes that
 * unrepresentable. That is the whole point of this tool -- not bookkeeping, but
 * removing the gap between doing a thing and the record of having done it.
 */

const INVOICE_TYPES = ['progress', 'time_and_materials', 'fixed_price', 'final'] as const
type InvoiceType = (typeof INVOICE_TYPES)[number]

export interface LogInvoiceSentInput {
  invoice_number: string
  client_name: string
  total_amount: number
  issue_date: string
  due_date: string
  invoice_type: string
  project?: string
  notes?: string
}

export const logInvoiceSent: Tool<LogInvoiceSentInput> = {
  name: 'log_invoice_sent',
  description:
    'Record that an invoice has been SENT to a client, so it starts ageing and shows up in ' +
    'get_receivables. Call this when the owner says they sent one, or immediately after one goes out. ' +
    'It records the send date as now — do not use it to back-fill an old invoice without saying so in ' +
    'the notes. Types: progress (a milestone), final, fixed_price, time_and_materials. This creates the ' +
    'record that money is owed, so it is staged for explicit confirmation first.',
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      invoice_number: {
        type: 'string',
        description: 'The number on the invoice as sent. Keep one scheme — ask which if the owner is inconsistent.',
      },
      client_name: { type: 'string', description: 'Who it was billed to, as written on the invoice.' },
      total_amount: { type: 'number', description: 'The invoice total.' },
      issue_date: { type: 'string', description: 'Date on the invoice, YYYY-MM-DD.' },
      due_date: { type: 'string', description: 'When payment is due, YYYY-MM-DD. Ask if not stated.' },
      invoice_type: {
        type: 'string',
        description: 'progress, final, fixed_price or time_and_materials. A milestone billing is "progress".',
      },
      project: { type: 'string', description: 'The job this belongs to, however it was named. Optional but worth having.' },
      notes: { type: 'string', description: 'Anything worth recording — including if this is being logged after the fact.' },
    },
    required: ['invoice_number', 'client_name', 'total_amount', 'issue_date', 'due_date', 'invoice_type'],
  },

  async execute(args, ctx) {
    if (!Number.isFinite(args.total_amount) || args.total_amount <= 0) {
      return { ok: false, error: 'An invoice total has to be a positive number.' }
    }
    for (const [field, value] of [['issue_date', args.issue_date], ['due_date', args.due_date]] as const) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, error: `${field} must be YYYY-MM-DD.` }
    }
    if (args.due_date < args.issue_date) {
      return { ok: false, error: 'The due date is before the issue date. Check which is which.' }
    }

    const type = args.invoice_type.trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (!(INVOICE_TYPES as readonly string[]).includes(type)) {
      return { ok: false, error: `"${args.invoice_type}" is not an invoice type. Use progress, final, fixed_price or time_and_materials.` }
    }

    let write: Awaited<ReturnType<typeof createBedrockWriteProvider>>
    try {
      write = await createBedrockWriteProvider(ctx.workspaceId)
    } catch (error) {
      if (error instanceof BedrockConnectionMissingError) {
        return { ok: false, error: 'This workspace is not connected to a construction ledger.' }
      }
      return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the ledger.' }
    }

    const createdBy = write.identityFor(ctx.operatorId).profileId
    if (!createdBy) {
      return {
        ok: false,
        error: 'No ledger identity is mapped for you, so this invoice cannot be attributed to a real person.',
      }
    }

    const adapter = createBedrockAdapter()

    // Optional, and deliberately not fatal. An invoice that reaches the ledger
    // without a job attached is still an invoice that ages and gets chased --
    // far better than one that exists nowhere because a name did not resolve.
    let projectId: string | null = null
    let projectNote: string | null = null
    if (args.project?.trim()) {
      try {
        const job = await resolveJob(adapter, ctx.workspaceId, args.project)
        if (job.match === 'one') projectId = job.candidates[0].id
        else projectNote = job.match === 'none'
          ? `No job matched "${args.project}", so this is recorded without one.`
          : `"${args.project}" matches ${job.count} jobs, so this is recorded without one. Say which and it can be attached.`
      } catch {
        projectNote = 'Could not check the job list, so this is recorded without a job attached.'
      }
    }

    const sentAt = new Date().toISOString()
    const result = await write.provider.insertInvoice(write.companyId, {
      invoice_number: args.invoice_number.trim(),
      client_name: args.client_name.trim(),
      invoice_type: type as InvoiceType,
      // Sent, not drafted. The distinction is the entire reason this exists.
      status: 'sent',
      issue_date: args.issue_date,
      due_date: args.due_date,
      total_amount: args.total_amount,
      subtotal: args.total_amount,
      project_id: projectId,
      notes: args.notes?.trim() || null,
      sent_at: sentAt,
      // Stated explicitly rather than omitted. Tax and terms are real fields on
      // an ODS invoice and leaving them undefined would look like "not known"
      // when it means "not captured here yet".
      client_id: null,
      estimate_id: null,
      tax_rate: null,
      tax_amount: null,
      terms: null,
      created_by: createdBy,
      company_id: write.companyId,
    })

    return {
      ok: result.ok,
      data: {
        invoice_number: args.invoice_number,
        client: args.client_name,
        amount: args.total_amount,
        type,
        due: args.due_date,
        recorded_as_sent_at: sentAt,
        project_attached: Boolean(projectId),
        project_note: projectNote,
        audit_recorded: result.auditLogWritten,
        failed: result.failedRows.map((f) => f.error),
        note: result.ok
          ? 'Recorded as sent. It will age from its issue date and appear in get_receivables until a payment is recorded against it.'
          : 'Nothing was recorded. Do not assume it is tracked.',
      },
    }
  },
}
