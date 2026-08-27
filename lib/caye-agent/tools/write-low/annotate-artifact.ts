import 'server-only'
import { annotateArtifact } from '@/lib/artifacts/relations'
import { getMostRecentArtifactForOperator } from '@/lib/artifacts/query'
import type { Tool } from '../types'

interface AnnotateArtifactInput {
  artifact_id?: string
  meaning: string
  relation_type?: string
  target_entity_type?: string
  target_entity_id?: string
}

/** How long "remember THIS" can implicitly mean "the thing I just sent." */
const RECENT_ARTIFACT_WINDOW_MS = 2 * 60 * 60 * 1000 // matches active-work's own 2hr window convention

export const annotateArtifactTool: Tool<AnnotateArtifactInput> = {
  name: 'annotate_artifact',
  description:
    'Record what an image/document/audio/video ACTUALLY means or relates to, as told to you by ' +
    'the operator — e.g. "that\'s the Casino tram stop where cruise guests meet Max", "this is ' +
    'the waiver for the snorkeling tour". This is how a low-confidence model guess gets ' +
    'corrected into durable, operator-confirmed truth: the old guess is preserved in history, ' +
    'the new meaning becomes authoritative.\n\n' +
    'Omit artifact_id when the operator is clearly talking about the file they JUST sent in this ' +
    "conversation — it resolves to their most recent artifact automatically. Only owner/founder " +
    'corrections are durable here, matching how business facts are learned.',
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      artifact_id: {
        type: 'string',
        description: 'Optional. Omit to target the most recent artifact this operator sent.',
      },
      meaning: {
        type: 'string',
        description: 'The operator-stated meaning, as a complete standalone sentence, e.g. "The Casino tram stop, where all cruise guests meet Max for pickup."',
      },
      relation_type: {
        type: 'string',
        description: 'Optional relation kind if this links to a specific business entity, e.g. "depicts_location", "relates_to_booking". Omit for a general annotation with no entity link.',
      },
      target_entity_type: {
        type: 'string',
        description: 'Optional — e.g. "contact", "booking", "service". Required together with target_entity_id.',
      },
      target_entity_id: {
        type: 'string',
        description: 'Optional — the id of the entity this artifact relates to. Required together with target_entity_type.',
      },
    },
    required: ['meaning'],
  },
  async execute(args, ctx) {
    const meaning = args.meaning.trim()
    if (meaning.length < 3) return { ok: false, error: 'Meaning is too short to be useful.' }
    if (!ctx.operatorId) return { ok: false, error: 'No operator identity on this request.' }

    let artifactId = args.artifact_id
    if (!artifactId) {
      const recent = await getMostRecentArtifactForOperator({
        workspaceId: ctx.workspaceId,
        operatorAllowlistId: ctx.operatorId,
        withinMs: RECENT_ARTIFACT_WINDOW_MS,
      })
      if (!recent) {
        return { ok: false, error: "I don't have a recent file from you to attach that meaning to — send it again or give me the artifact_id." }
      }
      artifactId = recent.id
    }

    if ((args.target_entity_type && !args.target_entity_id) || (!args.target_entity_type && args.target_entity_id)) {
      return { ok: false, error: 'target_entity_type and target_entity_id must be given together.' }
    }

    const result = await annotateArtifact({
      workspaceId: ctx.workspaceId,
      artifactId,
      operatorAllowlistId: ctx.operatorId,
      meaning,
      relationType: args.relation_type,
      targetEntityType: args.target_entity_type,
      targetEntityId: args.target_entity_id,
    })

    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, data: { artifact_id: artifactId, observation_id: result.observationId, relation_id: result.relationId } }
  },
}
