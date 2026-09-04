import { NextRequest, NextResponse } from 'next/server'
import { requireFreightWorkspaceAuthority } from '@/lib/freight/authorization'
import {
  FreightOperationError,
  analyzeFreightWorkflow,
  generateFreightDocument,
  getGeneratedFreightArtifact,
  listFreightConversations,
  loadFreightConversation,
  sendFreightDocument,
} from '@/lib/freight/server-operations'

function errorResponse(error: unknown) {
  if (error instanceof FreightOperationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : 'Freight operation failed' }, { status: 500 })
}

async function authority(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  const conversationId = req.nextUrl.searchParams.get('conversationId')
  if (!workspaceId) return { error: NextResponse.json({ error: 'workspaceId is required' }, { status: 400 }) }
  const actor = await requireFreightWorkspaceAuthority(req, workspaceId)
  if (!actor) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { workspaceId, conversationId, actor }
}

export async function GET(req: NextRequest) {
  const auth = await authority(req)
  if ('error' in auth) return auth.error
  try {
    if (!auth.conversationId) {
      const conversations = await listFreightConversations(auth.workspaceId)
      return NextResponse.json({
        conversations: conversations.map((row: any) => ({
          id: row.id,
          customerName: row.customer_name,
          customerId: row.customer_id,
          subject: row.metadata?.subject ?? null,
          lastMessageAt: row.last_message_at,
          freightStatus: row.metadata?.freight_workflow?.status ?? null,
        })),
      })
    }

    await loadFreightConversation(auth.workspaceId, auth.conversationId)
    const state = await analyzeFreightWorkflow(auth.workspaceId, auth.conversationId)
    if (!state) return NextResponse.json({ isFreightDocumentRequest: false })

    if (req.nextUrl.searchParams.get('artifact') === '1') {
      const artifact = await getGeneratedFreightArtifact(auth.workspaceId, auth.conversationId)
      if (!artifact.url) return NextResponse.json({ error: 'Could not prepare that file right now — try again.' }, { status: 502 })
      return NextResponse.json({
        artifact: {
          id: artifact.artifact.id,
          filename: artifact.artifact.filename,
          mimeType: artifact.artifact.detected_mime_type,
          url: artifact.url,
        },
      })
    }

    return NextResponse.json({ ...state, isFreightDocumentRequest: true })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  const auth = await authority(req)
  if ('error' in auth) return auth.error
  if (!auth.conversationId) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })

  const body = await req.json().catch(() => ({})) as { action?: string; evidenceId?: string }
  try {
    if (body.action === 'generate') {
      const record = await generateFreightDocument({
        workspaceId: auth.workspaceId,
        conversationId: auth.conversationId,
        evidenceId: body.evidenceId,
      })
      return NextResponse.json({ ...record, isFreightDocumentRequest: true })
    }

    if (body.action !== 'approve_send') return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

    const result = await sendFreightDocument({
      workspaceId: auth.workspaceId,
      conversationId: auth.conversationId,
      actor: {
        userId: auth.actor.userId,
        actorKind: auth.actor.actorKind,
        // Dashboard approval is tied to the authenticated user. The shared
        // operation requires a numeric actor binding because WhatsApp uses
        // operator_allowlist ids; zero is reserved for this authenticated
        // dashboard transport and never comes from the WhatsApp path.
        operatorId: 0,
      },
    })

    if (result.outcome === 'ambiguous' || result.outcome === 'retryable_failure') {
      return NextResponse.json({ error: result.message }, { status: 502 })
    }
    return NextResponse.json({ ...result.record, isFreightDocumentRequest: true })
  } catch (error) {
    return errorResponse(error)
  }
}
