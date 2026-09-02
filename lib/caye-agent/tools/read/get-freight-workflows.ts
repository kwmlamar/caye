import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getGeneratedFreightArtifact } from '@/lib/freight/server-operations'
import type { FreightWorkflowRecord } from '@/lib/freight/workflow'
import { freightOwnerSummary } from '@/lib/freight/whatsapp-orchestration'
import type { Tool } from '../types'

interface Input { query?: string; include_sent?: boolean }

const GENERIC_QUERY_WORDS = new Set([
  'handle', 'that', 'this', 'one', 'thing', 'freight', 'email', 'send', 'sent', 'show', 'make', 'prepare',
  'document', 'invoice', 'please', 'take', 'care', 'what', 'does', 'need', 'did', 'you', 'the', 'it', 'again',
])

function meaningfulQueryTokens(query?: string): string[] {
  if (!query?.trim()) return []
  return query
    .toLowerCase()
    .split(/[^a-z0-9@.-]+/)
    .filter(token => token.length > 2 && !GENERIC_QUERY_WORDS.has(token))
}

export const getFreightWorkflows: Tool<Input> = {
  name: 'get_freight_workflows',
  description:
    'Read the workspace freight-document workflow state used by the Inbox. Use for natural owner requests about freight, dock receipts, King Ocean or another freight provider, pending freight documents, whether one was sent, and generic follow-ups like "send it" or "show me". ' +
    'For generic follow-ups, omit query or pass the natural text; generic action words are ignored so all plausible workspace-local freight referents are returned. If more than one plausible prepared item remains, do not choose one. ' +
    'Prepared items include the exact send_binding needed by send_freight_document. This is the SAME state as the dashboard, not a WhatsApp-only state machine. Never expose internal confidence/status/id fields in the operator-facing prose.',
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

    const tokens = meaningfulQueryTokens(args.query)
    const items: Array<Record<string, unknown>> = []
    for (const row of data ?? []) {
      const workflow = (row as any).metadata?.freight_workflow as FreightWorkflowRecord | undefined
      if (!workflow || workflow.workspaceId !== ctx.workspaceId || workflow.conversationId !== (row as any).id) continue
      if (!args.include_sent && workflow.status === 'SENT') continue
      const haystack = [
        workflow.request.freightProvider,
        workflow.request.senderName,
        workflow.request.senderEmail,
        workflow.request.dockReceiptNumber,
        workflow.request.shipmentReference,
        (row as any).customer_name,
      ].filter(Boolean).join(' ').toLowerCase()
      if (tokens.length && !tokens.some(token => haystack.includes(token))) continue

      const recipient = workflow.request.senderEmail || (row as any).customer_id
      let artifactVersion: string | null = null
      if (workflow.status === 'READY_FOR_APPROVAL' && workflow.generatedArtifactId) {
        try {
          const generated = await getGeneratedFreightArtifact(ctx.workspaceId, (row as any).id)
          artifactVersion = generated.artifactVersion
        } catch {
          artifactVersion = null
        }
      }
      const sendBinding = workflow.status === 'READY_FOR_APPROVAL' && workflow.generatedArtifactId && artifactVersion
        ? {
            conversation_id: (row as any).id,
            artifact_id: workflow.generatedArtifactId,
            artifact_version: artifactVersion,
            recipient,
            email_thread_id: (row as any).channel_conversation_id,
          }
        : null

      items.push({
        conversation_id: (row as any).id,
        provider: workflow.request.freightProvider,
        sender_name: workflow.request.senderName,
        recipient,
        email_thread_id: (row as any).channel_conversation_id,
        dock_receipt: workflow.request.dockReceiptNumber,
        shipment_reference: workflow.request.shipmentReference,
        selected_evidence_id: workflow.selectedEvidenceId,
        generated_artifact_id: workflow.generatedArtifactId,
        is_prepared: workflow.status === 'READY_FOR_APPROVAL',
        is_sent: workflow.status === 'SENT',
        send_binding: sendBinding,
        summary: freightOwnerSummary({
          workflow,
          providerLabel: workflow.request.freightProvider || (row as any).customer_name || 'Freight provider',
          recipient,
          emailThreadId: (row as any).channel_conversation_id,
          artifactVersion,
        }),
      })
    }

    const prepared = items.filter(item => item.is_prepared === true)
    return {
      ok: true,
      data: {
        matched: items.length,
        ambiguous: items.length > 1,
        prepared_count: prepared.length,
        send_ambiguous: prepared.length > 1,
        items,
      },
    }
  },
}
