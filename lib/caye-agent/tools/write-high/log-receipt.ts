import 'server-only'

import {
  createBedrockAdapter,
  createBedrockWriteProvider,
  BedrockConnectionMissingError,
} from '@/lib/domain-adapters/bedrock'
import { createServiceClient } from '@/lib/supabase-server'
import { downloadWhatsAppMedia } from '@/lib/whatsapp/media'
import { resolveJob } from '../read/find-job'
import type { Tool } from '../types'

/**
 * Record a receipt the owner photographed.
 *
 * WHAT THIS FIXES
 *
 * Job costing at ODS has one half. There are 3,883 timesheet rows going back
 * sixteen months and SIX receipts, none of which is attached to a job. Labour
 * is measured to the cent and materials are essentially unrecorded, so no
 * job's real cost is knowable. The audit called the missing half money-out;
 * this is the way it gets entered, because photographing a receipt is the
 * only step anybody will actually do on a site.
 *
 * WHY THE PHOTO IS FETCHED AGAIN AT WRITE TIME
 *
 * This is a `high` risk tool, so it is staged and shown to the operator
 * before it runs -- Caye proposes what she read off the receipt, a person
 * agrees, and only then does this execute. That confirmation lands on a
 * LATER turn, and the model only ever receives image bytes on the turn they
 * arrive (see handleImageInbound). So the bytes are gone by the time this
 * runs, and it re-fetches them from Meta using the media id persisted on the
 * message row.
 *
 * The alternative -- uploading eagerly when the photo arrives -- would put
 * unconfirmed images into another company's storage before anyone approved
 * anything. Nothing reaches the ledger, storage included, until a human says
 * so.
 *
 * WHY THE SAME PHOTO CANNOT BE LOGGED TWICE
 *
 * The stored filename is derived from the media id, and the upload refuses to
 * overwrite. A second attempt on the same photo collides and fails with a
 * real reason rather than quietly creating a duplicate receipt.
 */

/** How far back to look for the photo being talked about. */
const PHOTO_LOOKBACK_MS = 60 * 60 * 1000

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
}

export interface LogReceiptInput {
  vendor?: string
  total_amount?: number
  receipt_date?: string
  project?: string
  notes?: string
  photo_message_id?: string
}

interface ResolvedPhoto {
  mediaId: string
  mimeType: string
  waMessageId: string
  arrivedAt: string
}

/**
 * The photo this receipt is about.
 *
 * Defaults to the most recent image this operator sent, which is what
 * "here's the receipt" means in practice. An explicit `photo_message_id`
 * wins when the model knows which one is meant -- two receipts photographed
 * one after another would otherwise both resolve to the second.
 */
async function resolvePhoto(args: {
  workspaceId: string
  operatorId: number | null
  waMessageId?: string
  now: Date
}): Promise<ResolvedPhoto | { error: string }> {
  const supabase = createServiceClient()
  let query = supabase
    .from('caye_operator_messages')
    .select('wa_message_id, inbound_media, created_at')
    .eq('workspace_id', args.workspaceId)
    .eq('direction', 'inbound')
    .not('inbound_media', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (args.waMessageId) {
    query = query.eq('wa_message_id', args.waMessageId)
  } else {
    query = query.gte('created_at', new Date(args.now.getTime() - PHOTO_LOOKBACK_MS).toISOString())
    if (args.operatorId != null) query = query.eq('operator_allowlist_id', args.operatorId)
  }

  const { data, error } = await query.maybeSingle()
  if (error) return { error: `Could not look up the photo — ${error.message}` }
  if (!data) {
    return {
      error: args.waMessageId
        ? 'That message does not have a photo on it.'
        : 'I do not have a recent photo to attach to this. Send the receipt photo and I will record it.',
    }
  }

  const media = data.inbound_media as { media_id?: unknown; mime_type?: unknown } | null
  const mediaId = typeof media?.media_id === 'string' ? media.media_id : null
  const mimeType = typeof media?.mime_type === 'string' ? media.mime_type : null
  if (!mediaId || !mimeType) {
    return { error: 'That photo arrived before receipts could be recorded, so its image cannot be retrieved.' }
  }

  return {
    mediaId,
    mimeType,
    waMessageId: data.wa_message_id as string,
    arrivedAt: data.created_at as string,
  }
}

/**
 * Injection seam, mirroring `makeGetReceivables`. Every collaborator this
 * tool has reaches a live system -- the ledger, Meta's media API, Supabase --
 * so a test can only exercise the decisions (what gets recorded, what gets
 * refused, what is reported as missing) if they are replaceable.
 */
export interface LogReceiptDeps {
  getWriteProvider: typeof createBedrockWriteProvider
  getAdapter: typeof createBedrockAdapter
  downloadMedia: typeof downloadWhatsAppMedia
  findPhoto: typeof resolvePhoto
  resolveJobBy: typeof resolveJob
}

export function makeLogReceipt(deps: Partial<LogReceiptDeps> = {}): Tool<LogReceiptInput> {
  const getWriteProvider = deps.getWriteProvider ?? createBedrockWriteProvider
  const getAdapter = deps.getAdapter ?? createBedrockAdapter
  const downloadMedia = deps.downloadMedia ?? downloadWhatsAppMedia
  const findPhoto = deps.findPhoto ?? resolvePhoto
  const resolveJobBy = deps.resolveJobBy ?? resolveJob

  return {
  name: 'log_receipt',
  description:
    'Record a receipt the owner photographed, so materials spending lands against a job. Call this ' +
    'after reading a receipt photo, filling in what you can actually SEE on it — leave a field out ' +
    'rather than guessing it. Ask which job it belongs to; recording it without one is fine if nobody ' +
    'knows, and better than attaching it to the wrong job. This writes to the construction ledger, so ' +
    'it is staged for explicit confirmation first, and the photo itself is attached at that point.',
  risk: 'high',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: 'The shop or supplier, as printed on the receipt. Omit if it is not legible.' },
      total_amount: { type: 'number', description: 'The receipt total. Omit if you cannot read it clearly — do not estimate.' },
      receipt_date: { type: 'string', description: 'Date on the receipt, YYYY-MM-DD. Omit if not printed or not legible.' },
      project: { type: 'string', description: 'The job it belongs to, however it was named. Ask; omit if nobody knows.' },
      notes: { type: 'string', description: 'Anything worth recording — what it was for, or that a field was unreadable.' },
      photo_message_id: {
        type: 'string',
        description: 'Only when a specific earlier photo is meant. Defaults to the most recent one sent.',
      },
    },
    required: [],
  },

  async execute(args, ctx) {
    if (args.total_amount !== undefined) {
      if (!Number.isFinite(args.total_amount) || args.total_amount <= 0) {
        return { ok: false, error: 'A receipt total has to be a positive number. Leave it out if you cannot read it.' }
      }
    }
    if (args.receipt_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.receipt_date)) {
      return { ok: false, error: 'receipt_date must be YYYY-MM-DD.' }
    }

    let write: Awaited<ReturnType<typeof createBedrockWriteProvider>>
    try {
      write = await getWriteProvider(ctx.workspaceId)
    } catch (error) {
      if (error instanceof BedrockConnectionMissingError) {
        return { ok: false, error: 'This workspace is not connected to a construction ledger.' }
      }
      return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the ledger.' }
    }

    const submittedBy = write.identityFor(ctx.operatorId).profileId

    const photo = await findPhoto({
      workspaceId: ctx.workspaceId,
      operatorId: ctx.operatorId ?? null,
      waMessageId: args.photo_message_id,
      now: new Date(),
    })
    if ('error' in photo) return { ok: false, error: photo.error }

    // Same optional-and-not-fatal handling log_invoice_sent uses: a receipt in
    // the ledger with no job attached is still a receipt that can be found and
    // attributed later. One attached to the WRONG job is worse than one
    // attached to none, so a name that does not resolve is reported, never
    // guessed.
    const adapter = getAdapter()
    let projectId: string | null = null
    let projectNote: string | null = null
    if (args.project?.trim()) {
      try {
        const job = await resolveJobBy(adapter, ctx.workspaceId, args.project)
        if (job.match === 'one') projectId = job.candidates[0].id
        else projectNote = job.match === 'none'
          ? `No job matched "${args.project}", so this is recorded without one.`
          : `"${args.project}" matches ${job.count} jobs, so this is recorded without one. Say which and it can be attached.`
      } catch {
        projectNote = 'Could not check the job list, so this is recorded without a job attached.'
      }
    }

    let bytes: Uint8Array
    try {
      const media = await downloadMedia(photo.mediaId)
      bytes = Buffer.from(media.base64, 'base64')
    } catch (error) {
      return {
        ok: false,
        error: `The photo could not be retrieved, so nothing was recorded — a receipt is not worth having without its image. ${
          error instanceof Error ? error.message : ''
        }`.trim(),
      }
    }

    // Deterministic on the media id: logging the same photo twice collides on
    // upload rather than silently creating a second receipt for it.
    const extension = EXTENSION_BY_MIME[photo.mimeType] ?? 'jpg'
    const upload = await write.provider.uploadReceiptImage(write.companyId, {
      bytes,
      mimeType: photo.mimeType,
      filename: `${photo.mediaId}.${extension}`,
    })
    if (!upload.ok) {
      return {
        ok: false,
        error: `The receipt image could not be stored, so nothing was recorded. ${upload.error}`,
      }
    }

    const result = await write.provider.insertReceipt(write.companyId, {
      image_url: upload.url,
      project_id: projectId,
      submitted_by: submittedBy,
      vendor: args.vendor?.trim() || null,
      receipt_date: args.receipt_date ?? null,
      total_amount: args.total_amount ?? null,
      notes: args.notes?.trim() || null,
      company_id: write.companyId,
    })

    // Say plainly which fields are NOT on the record. A receipt with no total
    // still helps -- the photo is filed against the job -- but reporting it as
    // if it were complete would be the same wrong-zero problem get_receivables
    // exists to avoid.
    const missing = [
      args.vendor?.trim() ? null : 'vendor',
      args.total_amount === undefined ? 'total' : null,
      args.receipt_date ? null : 'date',
      projectId ? null : 'job',
    ].filter(Boolean)

    return {
      ok: result.ok,
      data: {
        vendor: args.vendor?.trim() || null,
        total: args.total_amount ?? null,
        receipt_date: args.receipt_date ?? null,
        project_attached: Boolean(projectId),
        project_note: projectNote,
        photo_attached: true,
        photo_taken_from_message_at: photo.arrivedAt,
        not_recorded: missing,
        audit_recorded: result.auditLogWritten,
        failed: result.failedRows.map((f) => f.error),
        note: result.ok
          ? missing.length
            ? `Recorded, with the photo attached. Not on the record: ${missing.join(', ')}. It can be filled in later.`
            : 'Recorded, with the photo attached.'
          : 'Nothing was recorded. Do not assume the receipt is filed.',
      },
    }
  },
  }
}

export const logReceipt: Tool<LogReceiptInput> = makeLogReceipt()
