import 'server-only'
import { FreightOperationError, loadFreightConversation, sendFreightDocument } from '@/lib/freight/server-operations'
import type { FreightApprovalBinding } from '@/lib/freight/whatsapp-orchestration'
import { freightReferenceLabel } from '@/lib/freight/types'
import type { Tool } from '../types'

export interface SendFreightDocumentToolInput {
  conversation_id: string
  artifact_id: string
  artifact_version: string
  recipient: string
  email_thread_id: string
}

export const sendFreightDocumentTool: Tool<SendFreightDocumentToolInput> = {
  name: 'send_freight_document',
  description:
    'Send the exact prepared freight document for one resolved freight workflow. This is consequential and stays behind the normal high-risk confirmation round trip. ' +
    'Use the exact artifact_id, artifact_version, recipient, and email_thread_id returned by prepare_freight_document (or get_freight_workflows for an already-prepared item). ' +
    'Never substitute current-looking values yourself and never use a raw email attachment tool for freight. The shared domain operation independently revalidates the binding immediately before Gmail.',
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'Exact prepared freight conversation id.' },
      artifact_id: { type: 'string', description: 'Exact generated freight artifact id returned by prepare_freight_document.' },
      artifact_version: { type: 'string', description: 'Exact generated artifact version returned by prepare_freight_document.' },
      recipient: { type: 'string', description: 'Exact recipient bound when the document was prepared.' },
      email_thread_id: { type: 'string', description: 'Exact Gmail thread id bound when the document was prepared.' },
    },
    required: ['conversation_id', 'artifact_id', 'artifact_version', 'recipient', 'email_thread_id'],
  },
  async execute(args, ctx) {
    if (ctx.operatorId == null) return { ok: false, error: 'I could not verify who approved that send.' }
    try {
      const conv = await loadFreightConversation(ctx.workspaceId, args.conversation_id)
      const approvalBinding: FreightApprovalBinding = {
        workspaceId: ctx.workspaceId,
        workflowId: ((conv.metadata?.freight_workflow as { id?: string } | undefined)?.id ?? ''),
        artifactId: args.artifact_id,
        artifactVersion: args.artifact_version,
        recipient: args.recipient,
        emailThreadId: args.email_thread_id,
        actorOperatorId: ctx.operatorId,
        approvedAt: new Date().toISOString(),
      }
      if (!approvalBinding.workflowId) return { ok: false, error: 'That freight request is no longer available.' }

      const result = await sendFreightDocument({
        workspaceId: ctx.workspaceId,
        conversationId: args.conversation_id,
        actor: {
          userId: `operator:${ctx.operatorId}`,
          actorKind: ctx.callerRole === 'founder' ? 'founder' : 'owner',
          operatorId: ctx.operatorId,
        },
        approvalBinding,
      })
      // Without this the confirmation to the owner carries no identifier at all for a TWINex
      // request, whose dockReceiptNumber is always null.
      const dock = result.record.request.reference ? freightReferenceLabel(result.record.request.reference) : null
      const recipientName = result.record.request.senderName || result.record.request.freightProvider || conv.customer_name || 'the freight provider'
      if (result.outcome === 'ambiguous') {
        return {
          ok: true,
          data: {
            sent: false,
            delivery_uncertain: true,
            operator_message: "I'm not certain that email went through, so I won't retry it automatically. I'll keep it flagged for us to check.",
          },
        }
      }
      if (result.outcome === 'retryable_failure') {
        return { ok: false, error: `I couldn't send that before Gmail accepted it. ${result.message}` }
      }
      if (result.outcome === 'already_sent') {
        return {
          ok: true,
          data: {
            sent: true,
            deduped: true,
            operator_message: `That freight document${dock ? ` for ${dock}` : ''} was already sent. I didn't send it again.`,
          },
        }
      }
      return {
        ok: true,
        data: {
          sent: true,
          operator_message: `Sent ${recipientName} the freight document${dock ? ` for ${dock}` : ''}.`,
        },
      }
    } catch (error) {
      if (error instanceof FreightOperationError) return { ok: false, error: error.message, error_code: error.code }
      return { ok: false, error: error instanceof Error ? error.message : 'Could not send the freight document.' }
    }
  },
}
