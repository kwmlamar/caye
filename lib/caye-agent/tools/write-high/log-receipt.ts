import 'server-only'

import {
  createBedrockAdapter,
  createBedrockWriteProvider,
  BedrockConnectionMissingError,
} from '@/lib/domain-adapters/bedrock'
import { createServiceClient } from '@/lib/supabase-server'
import { downloadWhatsAppMedia } from '@/lib/whatsapp/media'
import { resolveJob } from '../read/find-job'
import { resolveMaterial } from '../read/find-material'
import type { Tool } from '../types'

/**
 * Record a receipt the owner sent — a photo or a PDF.
 *
 * WHAT THIS FIXES
 *
 * Job costing at ODS has one half. There are 3,883 timesheet rows going back
 * sixteen months and SIX receipts, none of which is attached to a job. Labour
 * is measured to the cent and materials are essentially unrecorded, so no
 * job's real cost is knowable. The audit called the missing half money-out;
 * this is the way it gets entered, because sending a receipt over WhatsApp is
 * the only step anybody will actually do on a site.
 *
 * WHY THE MEDIA IS FETCHED AGAIN AT WRITE TIME
 *
 * This is a `high` risk tool, so it is staged and shown to the operator
 * before it runs -- Caye proposes what she read off the receipt, a person
 * agrees, and only then does this execute. That confirmation lands on a
 * LATER turn, and the model only ever receives the photo or PDF bytes on the
 * turn they arrive (see handleImageInbound / handleDocumentInbound). So the
 * bytes are gone by the time this runs, and it re-fetches them from Meta
 * using the media id persisted on the message row.
 *
 * The alternative -- uploading eagerly when the receipt arrives -- would put
 * unconfirmed images into another company's storage before anyone approved
 * anything. Nothing reaches the ledger, storage included, until a human says
 * so.
 *
 * WHY THE SAME RECEIPT CANNOT BE LOGGED TWICE
 *
 * The stored filename is derived from the media id, and the upload refuses to
 * overwrite. A second attempt on the same photo or PDF collides and fails
 * with a real reason rather than quietly creating a duplicate receipt.
 *
 * LINE ITEMS AND MATERIALS
 *
 * Each line item is matched against the existing `materials` catalog by
 * name/category/supplier (see find-material.ts) -- a single confident match
 * links to it; more than one plausible match is left unlinked rather than
 * guessed at, the same rule find-job.ts uses for an ambiguous job name.
 * Materials writes are insert-only: an existing row's price is never
 * touched, so this can never silently overwrite a catalog price the way a
 * bad receipt once did. A new row is only created when a price is actually
 * known -- `materials.unit_cost` has no default, so a line item with no
 * legible price is recorded on the receipt with no catalog link rather than
 * inventing one. The `R<epoch>_<index>` id and `division_name: 'From
 * Receipt'` follow the exact convention already live in TropiTrack's own
 * materials table (12 rows, predating this tool), not a new one invented
 * here.
 */

/** How far back to look for the receipt being talked about. */
const RECEIPT_MEDIA_LOOKBACK_MS = 60 * 60 * 1000

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
}

// Best-effort CSI MasterFormat division code, used only when a line item
// creates a brand-new materials row and the model did not supply one itself.
// materials.division_code is NOT NULL with no default, so this exists purely
// to satisfy that constraint sensibly -- it is soft catalog organization, not
// a financial fact, and getting it wrong does not corrupt job costing the
// way a wrong price or a wrong job would.
const DIVISION_CODE_KEYWORDS: Array<{ code: string; keywords: string[] }> = [
  { code: '03', keywords: ['concrete', 'cement', 'rebar', 'mortar'] },
  { code: '04', keywords: ['block', 'brick', 'masonry'] },
  { code: '05', keywords: ['metal', 'steel', 'fastener', 'screw', 'bolt', 'nail', 'anchor', 'tin tab'] },
  { code: '06', keywords: ['lumber', 'wood', 'plywood', 'ply', 'stud', 'framing', 'cypress'] },
  { code: '07', keywords: ['waterproof', 'membrane', 'insulation', 'roofing', 'shingle', 'gutter', 'flashing'] },
  { code: '08', keywords: ['door', 'window', 'glass', 'glazing'] },
  { code: '09', keywords: ['drywall', 'plaster', 'paint', 'primer', 'tile', 'trowel', 'joint compound', 'finish'] },
  { code: '16', keywords: ['electrical', 'wire', 'outlet', 'conduit', 'breaker', 'switch'] },
  { code: '22', keywords: ['plumb', 'pipe', 'valve', 'faucet', 'fitting', 'drain', 'toilet', 'sink'] },
]
const DEFAULT_DIVISION_CODE = '00'

function inferDivisionCode(supplied: string | undefined, text: string): string {
  if (supplied && /^\d{2}$/.test(supplied.trim())) return supplied.trim()
  const haystack = text.toLowerCase()
  const found = DIVISION_CODE_KEYWORDS.find(({ keywords }) => keywords.some(k => haystack.includes(k)))
  return found?.code ?? DEFAULT_DIVISION_CODE
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export interface LogReceiptLineItemInput {
  description: string
  quantity?: number
  unit?: string
  unit_price?: number
  category?: string
  division_code?: string
}

export interface LogReceiptInput {
  vendor?: string
  total_amount?: number
  receipt_date?: string
  project?: string
  notes?: string
  photo_message_id?: string
  line_items?: LogReceiptLineItemInput[]
}

interface ResolvedReceiptMedia {
  mediaId: string
  mimeType: string
  waMessageId: string
  arrivedAt: string
}

/**
 * The photo or PDF this receipt is about.
 *
 * Defaults to the most recent receipt-shaped message this operator sent,
 * which is what "here's the receipt" means in practice. An explicit
 * `photo_message_id` wins when the model knows which one is meant -- two
 * receipts sent one after another would otherwise both resolve to the most
 * recent one.
 */
async function resolveReceiptMedia(args: {
  workspaceId: string
  operatorId: number | null
  waMessageId?: string
  now: Date
}): Promise<ResolvedReceiptMedia | { error: string }> {
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
    query = query.gte('created_at', new Date(args.now.getTime() - RECEIPT_MEDIA_LOOKBACK_MS).toISOString())
    if (args.operatorId != null) query = query.eq('operator_allowlist_id', args.operatorId)
  }

  const { data, error } = await query.maybeSingle()
  if (error) return { error: `Could not look up the receipt — ${error.message}` }
  if (!data) {
    return {
      error: args.waMessageId
        ? 'That message does not have a photo or PDF on it.'
        : 'I do not have a recent photo or PDF to attach to this. Send the receipt and I will record it.',
    }
  }

  const media = data.inbound_media as { media_id?: unknown; mime_type?: unknown } | null
  const mediaId = typeof media?.media_id === 'string' ? media.media_id : null
  const mimeType = typeof media?.mime_type === 'string' ? media.mime_type : null
  if (!mediaId || !mimeType) {
    return { error: 'That receipt arrived before receipts could be recorded, so it cannot be retrieved.' }
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
  findReceiptMedia: typeof resolveReceiptMedia
  resolveJobBy: typeof resolveJob
  findMaterialBy: typeof resolveMaterial
}

export function makeLogReceipt(deps: Partial<LogReceiptDeps> = {}): Tool<LogReceiptInput> {
  const getWriteProvider = deps.getWriteProvider ?? createBedrockWriteProvider
  const getAdapter = deps.getAdapter ?? createBedrockAdapter
  const downloadMedia = deps.downloadMedia ?? downloadWhatsAppMedia
  const findReceiptMedia = deps.findReceiptMedia ?? resolveReceiptMedia
  const resolveJobBy = deps.resolveJobBy ?? resolveJob
  const findMaterialBy = deps.findMaterialBy ?? resolveMaterial

  return {
  name: 'log_receipt',
  description:
    'Record a receipt the owner sent — a photo or a PDF — so materials spending lands against a job. Call ' +
    'this after reading the receipt, filling in what you can actually SEE on it — leave a field out rather ' +
    'than guessing it. Ask which job it belongs to; recording it without one is fine if nobody knows, and ' +
    'better than attaching it to the wrong job. Include line_items when the receipt itemizes what was bought ' +
    '— each is matched against the existing materials catalog or, if nothing matches and a price is legible, ' +
    'filed as a new catalog entry; an item whose price you cannot read is still recorded on the receipt, just ' +
    'without a catalog link. This writes to the construction ledger, so it is staged for explicit confirmation ' +
    'first, and the photo or PDF itself is attached at that point.',
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
        description: 'Only when a specific earlier photo or PDF is meant. Defaults to the most recent one sent.',
      },
      line_items: {
        type: 'array',
        description:
          'What the receipt itemizes, if it does. Omit entirely for a receipt with no readable itemization — ' +
          'the header fields alone are still worth recording. Leave any field out of an item you cannot read ' +
          'rather than guessing it.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'The item as printed on the receipt.' },
            quantity: { type: 'number', description: 'Quantity purchased, if printed.' },
            unit: { type: 'string', description: 'Unit of measure (e.g. EA, SHEET, BOX), if printed. Defaults to EA.' },
            unit_price: { type: 'number', description: 'Price per unit. Omit if not legible — do not estimate.' },
            category: {
              type: 'string',
              description: 'A short catalog category for this item (e.g. "Plumbing Fittings & Valves"), if you can tell.',
            },
            division_code: {
              type: 'string',
              description: 'A 2-digit CSI division code for this item, only if you are confident of one. Usually omit this.',
            },
          },
          required: ['description'],
        },
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
    const lineItems = args.line_items ?? []
    for (const item of lineItems) {
      if (!item.description?.trim()) {
        return { ok: false, error: 'Every line item needs a description. Drop the ones you cannot read instead of leaving description blank.' }
      }
      if (item.quantity !== undefined && (!Number.isFinite(item.quantity) || item.quantity <= 0)) {
        return { ok: false, error: `"${item.description}" has a quantity that is not a positive number. Leave it out if you cannot read it.` }
      }
      if (item.unit_price !== undefined && (!Number.isFinite(item.unit_price) || item.unit_price < 0)) {
        return { ok: false, error: `"${item.description}" has a unit price that is not a valid number. Leave it out if you cannot read it.` }
      }
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

    const media = await findReceiptMedia({
      workspaceId: ctx.workspaceId,
      operatorId: ctx.operatorId ?? null,
      waMessageId: args.photo_message_id,
      now: new Date(),
    })
    if ('error' in media) return { ok: false, error: media.error }

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
      const downloaded = await downloadMedia(media.mediaId)
      bytes = Buffer.from(downloaded.base64, 'base64')
    } catch (error) {
      return {
        ok: false,
        error: `The receipt could not be retrieved, so nothing was recorded — a receipt is not worth having without its image. ${
          error instanceof Error ? error.message : ''
        }`.trim(),
      }
    }

    // Deterministic on the media id: logging the same receipt twice collides
    // on upload rather than silently creating a second receipt for it.
    const extension = EXTENSION_BY_MIME[media.mimeType] ?? 'jpg'
    const upload = await write.provider.uploadReceiptImage(write.companyId, {
      bytes,
      mimeType: media.mimeType,
      filename: `${media.mediaId}.${extension}`,
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

    // Line items and materials matching only run once the receipt itself is
    // filed -- receipt_line_items.receipt_id is NOT NULL, so there is no row
    // to attach them to otherwise.
    const receiptId = result.ok ? result.insertedIds[0] : null
    const lineItemOutcomes: Array<{
      description: string
      linked_material_id: string | null
      created_material_id: string | null
      cataloged: boolean
      reason: string | null
    }> = []

    if (receiptId) {
      const vendor = args.vendor?.trim() || null
      const receiptDateForNotes = args.receipt_date ?? new Date().toISOString().slice(0, 10)
      // Each entry carries `matchReason` alongside the insertable row --
      // insertReceiptLineItems writes that into audit_logs (never into
      // receipt_line_items itself, which has no such column) so *why* a
      // line item did or didn't link is queryable afterward, not only
      // visible in this one WhatsApp turn.
      const entries: Parameters<typeof write.provider.insertReceiptLineItems>[1] = []

      for (let index = 0; index < lineItems.length; index++) {
        const item = lineItems[index]
        let materialId: string | null = null
        let matchConfidence: 'high' | 'none' = 'none'
        let createdMaterialId: string | null = null
        let reason: string | null = null

        let resolution: Awaited<ReturnType<typeof resolveMaterial>>
        try {
          resolution = await findMaterialBy(adapter, ctx.workspaceId, item.description)
        } catch {
          resolution = { match: 'none', count: 0, candidates: [] }
        }

        if (resolution.match === 'one') {
          materialId = resolution.candidates[0].id
          matchConfidence = 'high'
          reason = `Matched existing material ${materialId} ("${resolution.candidates[0].name}").`
        } else if (resolution.match === 'many') {
          reason = `${resolution.count} similar materials found — not linked to any of them.`
        } else if (item.unit_price === undefined) {
          reason = 'No legible unit price, so this was not added to the materials catalog.'
        } else {
          const newId = `R${Date.now()}_${index}`
          const category = item.category?.trim() || 'Uncategorized'
          const materialResult = await write.provider.insertMaterial(write.companyId, {
            id: newId,
            division_code: inferDivisionCode(item.division_code, `${item.description} ${category}`),
            division_name: 'From Receipt',
            category,
            name: item.description.trim(),
            unit: item.unit?.trim() || 'EA',
            unit_cost: item.unit_price,
            supplier: vendor,
            notes: `Added from receipt ${receiptDateForNotes}`,
          })
          if (materialResult.ok) {
            materialId = newId
            createdMaterialId = newId
            reason = `No existing match — created new materials catalog row ${newId}.`
          } else {
            reason = `Could not add this to the materials catalog (${materialResult.failedRows[0]?.error ?? 'unknown error'}), so it is recorded on the receipt only.`
          }
        }

        lineItemOutcomes.push({
          description: item.description,
          linked_material_id: resolution.match === 'one' ? materialId : null,
          created_material_id: createdMaterialId,
          cataloged: materialId !== null,
          reason,
        })

        entries.push({
          row: {
            receipt_id: receiptId,
            material_id: materialId,
            receipt_name: item.description.trim(),
            qty: item.quantity ?? null,
            unit: item.unit?.trim() || null,
            unit_cost: item.unit_price ?? null,
            total_cost: item.quantity !== undefined && item.unit_price !== undefined ? round2(item.quantity * item.unit_price) : null,
            match_confidence: matchConfidence,
          },
          matchReason: reason,
        })
      }

      if (entries.length > 0) {
        await write.provider.insertReceiptLineItems(write.companyId, entries)
      }
    }

    // Say plainly which fields are NOT on the record. A receipt with no total
    // still helps -- the receipt is filed against the job -- but reporting it
    // as if it were complete would be the same wrong-zero problem
    // get_receivables exists to avoid.
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
        photo_taken_from_message_at: media.arrivedAt,
        line_items_recorded: lineItemOutcomes.length,
        line_items: lineItemOutcomes,
        not_recorded: missing,
        audit_recorded: result.auditLogWritten,
        failed: result.failedRows.map((f) => f.error),
        note: result.ok
          ? missing.length
            ? `Recorded, with the receipt attached. Not on the record: ${missing.join(', ')}. It can be filled in later.`
            : 'Recorded, with the receipt attached.'
          : 'Nothing was recorded. Do not assume the receipt is filed.',
      },
    }
  },
  }
}

export const logReceipt: Tool<LogReceiptInput> = makeLogReceipt()
