import 'server-only'
import { searchArtifacts as runSearch } from '@/lib/artifacts/query'
import { quarantineUntrustedText } from '@/lib/artifacts/prompt-format'
import type { ArtifactModality } from '@/lib/artifacts/types'
import type { Tool } from '../types'

interface SearchArtifactsInput {
  query?: string
  modality?: ArtifactModality
  ordinal?: 'latest' | 'second_most_recent'
  from_operator_only?: boolean
}

export const searchArtifacts: Tool<SearchArtifactsInput> = {
  name: 'search_artifacts',
  description:
    'Find stored business artifacts (photos, PDFs/documents, receipts, etc.) the workspace has ' +
    'received or been shown — across ALL past conversations, not just this one. Use when the ' +
    'operator refers to a file by description ("the photo of the pink building", "that waiver ' +
    'PDF", "the receipt for the drywall job", "the logo I sent you"), by who sent it ("the PDF ' +
    'Jeff sent last month"), or positionally ("that image", "the second photo", "the one you ' +
    'just sent me" — use ordinal for these).\n\n' +
    'Returns a ranked list of matches with id, filename, modality, current understanding, and ' +
    'sender/date provenance. Follow up with get_artifact for full detail, or ' +
    'retrieve_artifact_for_operator to actually send the original file back. Do not guess an ' +
    'artifact_id — always search or use ordinal first.\n\n' +
    'If the response has ambiguous=true, the top matches scored EQUALLY — the query genuinely ' +
    "does not distinguish them (e.g. two different pickup-location photos both matching \"pickup " +
    'picture\"). Do NOT pick one arbitrarily and do not silently guess. Ask the operator a single ' +
    'focused clarifying question (e.g. name the distinguishing options) instead, unless the ' +
    'surrounding conversation already makes the intended one unambiguous.',
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text description of what to find, e.g. "pink building", "drywall receipt", "waiver". Omit when using ordinal alone.',
      },
      modality: {
        type: 'string',
        enum: ['image', 'document', 'audio', 'video', 'spreadsheet', 'other'],
        description: 'Optional filter to one file type.',
      },
      ordinal: {
        type: 'string',
        enum: ['latest', 'second_most_recent'],
        description: 'Use for "that image"/"the one you just sent" (latest) or "the second photo" (second_most_recent), scoped to whoever is asking unless from_operator_only is explicitly false.',
      },
      from_operator_only: {
        type: 'boolean',
        description: 'Default true when ordinal is set — resolves against artifacts sent by the CURRENT operator. Set false to search the whole workspace regardless of sender.',
      },
    },
  },
  async execute(args, ctx) {
    const wantsOperatorScope = args.ordinal && args.from_operator_only !== false
    const { items, ambiguous } = await runSearch({
      workspaceId: ctx.workspaceId,
      query: args.query,
      modality: args.modality,
      ordinal: args.ordinal,
      senderOperatorAllowlistId: wantsOperatorScope && ctx.operatorId ? ctx.operatorId : undefined,
      limit: 10,
    })

    if (items.length === 0) {
      return { ok: true, data: { matched: 0, items: [], ambiguous: false } }
    }

    return {
      ok: true,
      data: {
        matched: items.length,
        ambiguous,
        ...(ambiguous
          ? { ambiguity_note: 'The top matches scored equally — ask the operator which one they mean rather than picking one.' }
          : {}),
        items: items.map((r) => ({
          artifact_id: r.artifact.id,
          filename: r.artifact.filename,
          modality: r.artifact.modality,
          received_at: r.artifact.received_at,
          source_channel: r.artifact.source_channel,
          sender_operator_allowlist_id: r.artifact.sender_operator_allowlist_id,
          processing_status: r.artifact.processing_status,
          top_observation: summarizeObservation(r.matchedObservations[0]),
          confirmed_meaning: r.confirmedRelations[0]?.label ? quarantineUntrustedText('operator_annotation', r.confirmedRelations[0].label) : null,
        })),
      },
    }
  },
}

/**
 * Every string surfaced here is quarantined before it leaves this function —
 * this tool result is a model-prompt boundary exactly like get_artifact's,
 * and artifact-derived text (a PDF's extracted content, a model's visual
 * description) must never reach the model unquoted, here or anywhere else
 * observation content is surfaced.
 */
function summarizeObservation(o?: { observation_type: string; content: Record<string, unknown> }): string | null {
  if (!o) return null
  const content = o.content
  if (typeof content.description === 'string') return quarantineUntrustedText(o.observation_type, content.description)
  if (typeof content.summary === 'string') return quarantineUntrustedText(o.observation_type, content.summary)
  if (typeof content.meaning === 'string') return quarantineUntrustedText(o.observation_type, content.meaning)
  if (typeof content.text === 'string') return quarantineUntrustedText(o.observation_type, content.text.slice(0, 200))
  return null
}
