import 'server-only'
import { FreightOperationError, generateFreightDocument, getGeneratedFreightArtifact, loadFreightConversation } from '@/lib/freight/server-operations'
import { freightOwnerSummary } from '@/lib/freight/whatsapp-orchestration'
import type { Tool } from '../types'

interface Input {
  conversation_id: string
  evidence_id?: string
}

export const prepareFreightDocument: Tool<Input> = {
  name: 'prepare_freight_document',
  description:
    'Prepare the freight PDF for one already-resolved freight workflow. Use after get_freight_workflows identifies exactly one conversation. ' +
    'This calls the same domain operation as the dashboard and never sends email. If evidence is ambiguous, do not guess: ask which receipt to use. ' +
    'For a trusted matched receipt, omit evidence_id and the shared operation will use the selected candidate.',
  risk: 'low',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'Exact unified conversation id returned by get_freight_workflows.' },
      evidence_id: { type: 'string', description: 'Optional exact candidate evidence id when the operator explicitly selected one.' },
    },
    required: ['conversation_id'],
  },
  async execute(args, ctx) {
    try {
      const conv = await loadFreightConversation(ctx.workspaceId, args.conversation_id)
      const record = await generateFreightDocument({
        workspaceId: ctx.workspaceId,
        conversationId: args.conversation_id,
        evidenceId: args.evidence_id,
      })
      const artifact = await getGeneratedFreightArtifact(ctx.workspaceId, args.conversation_id)
      return {
        ok: true,
        data: {
          prepared: true,
          conversation_id: args.conversation_id,
          generated_artifact_id: record.generatedArtifactId,
          review_url: artifact.url,
          summary: freightOwnerSummary({
            workflow: record,
            providerLabel: record.request.freightProvider || conv.customer_name || 'Freight provider',
            recipient: record.request.senderEmail || conv.customer_id,
            emailThreadId: conv.channel_conversation_id,
            artifactVersion: artifact.artifactVersion,
          }),
        },
      }
    } catch (error) {
      if (error instanceof FreightOperationError) {
        return { ok: false, error: error.message, error_code: error.code }
      }
      return { ok: false, error: error instanceof Error ? error.message : 'Could not prepare the freight document.' }
    }
  },
}
