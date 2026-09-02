import 'server-only'
import { FreightOperationError, loadFreightConversation, sendFreightDocument } from '@/lib/freight/server-operations'
import type { Tool } from '../types'

interface Input {
  conversation_id: string
}

export const sendFreightDocumentTool: Tool<Input> = {
  name: 'send_freight_document',
  description:
    'Send the exact prepared freight document for one resolved freight workflow. This is consequential and must stay behind the normal high-risk confirmation round trip. ' +
    'Never use a raw email attachment tool for freight. The shared domain operation revalidates workspace, actor, artifact version, recipient, Gmail thread, current workflow state, and conversation execution immediately before the provider call.',
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'Exact prepared freight conversation id returned by get_freight_workflows/prepare_freight_document.' },
    },
    required: ['conversation_id'],
  },
  async execute(args, ctx) {
    if (ctx.operatorId == null) return { ok: false, error: 'I could not verify who approved that send.' }
    try {
      const conv = await loadFreightConversation(ctx.workspaceId, args.conversation_id)
      const result = await sendFreightDocument({
        workspaceId: ctx.workspaceId,
        conversationId: args.conversation_id,
        actor: {
          userId: `operator:${ctx.operatorId}`,
          actorKind: ctx.callerRole === 'founder' ? 'founder' : 'owner',
          operatorId: ctx.operatorId,
        },
      })
      const dock = result.record.request.dockReceiptNumber
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
        return {
          ok: false,
          error: `I couldn't send that before Gmail accepted it. ${result.message}`,
        }
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
