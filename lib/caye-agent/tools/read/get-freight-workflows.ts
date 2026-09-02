import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { FreightWorkflowRecord } from '@/lib/freight/workflow'
import { freightOwnerSummary } from '@/lib/freight/whatsapp-orchestration'
import type { Tool } from '../types'

interface Input { query?: string; include_sent?: boolean }

export const getFreightWorkflows: Tool<Input> = {
  name: 'get_freight_workflows',
  description: 'Read the workspace freight-document workflow state used by the Inbox. Use for natural owner requests about freight, dock receipts, King Ocean or another freight provider, pending freight documents, whether one was sent, or when resolving phrases like "that freight one". This is the SAME state as the dashboard, not a WhatsApp-only state machine. Never expose internal confidence/status/id fields to the operator; summarize naturally.',
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, include_sent: { type: 'boolean' } } },
  async execute(args, ctx) {
    const db = createServiceClient()
    const { data, error } = await db.from('unified_conversations')
      .select('id,customer_id,customer_name,channel_conversation_id,metadata,last_message_at,connected_accounts!inner(user_id)')
      .eq('connected_accounts.user_id', ctx.workspaceId)
      .eq('channel_type', 'gmail')
      .order('last_message_at', { ascending: false })
      .limit(50)
    if (error) return { ok: false, error: error.message }
    const q = args.query?.toLowerCase().trim()
    const items = (data ?? []).flatMap((row: any) => {
      const workflow = row.metadata?.freight_workflow as FreightWorkflowRecord | undefined
      if (!workflow || workflow.workspaceId !== ctx.workspaceId || workflow.conversationId !== row.id) return []
      if (!args.include_sent && workflow.status === 'SENT') return []
      const haystack = [workflow.request.freightProvider, workflow.request.senderName, workflow.request.senderEmail, workflow.request.dockReceiptNumber, workflow.request.shipmentReference, row.customer_name].filter(Boolean).join(' ').toLowerCase()
      if (q && !q.split(/\s+/).some(token => token.length > 2 && haystack.includes(token))) return []
      return [{
        conversation_id: row.id,
        provider: workflow.request.freightProvider,
        sender_name: workflow.request.senderName,
        recipient: workflow.request.senderEmail || row.customer_id,
        email_thread_id: row.channel_conversation_id,
        dock_receipt: workflow.request.dockReceiptNumber,
        shipment_reference: workflow.request.shipmentReference,
        selected_evidence_id: workflow.selectedEvidenceId,
        generated_artifact_id: workflow.generatedArtifactId,
        is_prepared: workflow.status === 'READY_FOR_APPROVAL',
        is_sent: workflow.status === 'SENT',
        summary: freightOwnerSummary({ workflow, providerLabel: workflow.request.freightProvider || row.customer_name || 'Freight provider', recipient: workflow.request.senderEmail || row.customer_id, emailThreadId: row.channel_conversation_id, artifactVersion: null }),
      }]
    })
    return { ok: true, data: { matched: items.length, ambiguous: items.length > 1, items } }
  },
}
