import 'server-only'

import { summarizeEscalation, sortEscalationsByPriority } from '@/lib/attention-briefing'
import { createServiceClient } from '@/lib/supabase-server'
import type { RegisteredCapability } from './types'

export type AttentionCapabilityItem = {
  id: string
  conversationId: string | null
  customerName: string | null
  summary: string
  decision: string | null
  booking: {
    serviceName: string | null
    bookingDate: string
    numberOfPeople: number
  } | null
  createdAt: string
}

type EscalationRow = {
  id: string
  conversation_id: string | null
  category: string | null
  customer_facing_message: string | null
  internal_context: string | null
  created_at: string
}

type ConversationRow = { id: string; customer_name: string | null }
type BookingRow = {
  conversation_id: string | null
  booking_date: string
  number_of_people: number
  service: { name: string }[] | { name: string } | null
}

function serviceName(service: BookingRow['service']): string | null {
  return Array.isArray(service) ? (service[0]?.name ?? null) : (service?.name ?? null)
}

/**
 * Read-only founder attention boundary. Attention is always workspace-scoped;
 * operator/global context cannot ask for an unbounded cross-customer queue.
 * Raw internal_context is used only as input to the existing safe briefing
 * formatter and never crosses the capability boundary.
 */
export const attentionListCapability: RegisteredCapability<Record<string, never>, AttentionCapabilityItem[]> = {
  manifest: {
    name: 'attention.list',
    version: 1,
    namespace: 'attention',
    description: 'List unresolved founder attention items for the active workspace.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'attention.list.input.v1',
    outputSchemaId: 'attention.list.output.v1',
  },

  async execute(_args, context) {
    const workspaceId = context.scope.workspaceId
    if (!workspaceId) {
      return {
        status: 'failed',
        data: null,
        evidence: [],
        executionRef: null,
        auditRef: null,
        failure: {
          code: 'invalid_scope',
          message: 'Attention requires an active workspace.',
          retryable: false,
        },
      }
    }

    try {
      const supabase = createServiceClient()
      const { data: escalationData, error: escalationError } = await supabase
        .from('caye_escalations')
        .select('id, conversation_id, category, customer_facing_message, internal_context, created_at')
        .eq('workspace_id', workspaceId)
        .is('owner_responded_at', null)
        .is('expired_at', null)
        .order('created_at', { ascending: true })
        .limit(50)

      if (escalationError) return unavailable()
      const escalations = (escalationData ?? []) as EscalationRow[]
      if (escalations.length === 0) {
        return {
          status: 'observed',
          data: [],
          evidence: [],
          executionRef: null,
          auditRef: null,
          failure: null,
        }
      }

      const conversationIds = Array.from(new Set(
        escalations.map((row) => row.conversation_id).filter((id): id is string => Boolean(id))
      ))

      const customerByConversation = new Map<string, string>()
      const bookingByConversation = new Map<string, AttentionCapabilityItem['booking']>()

      if (conversationIds.length > 0) {
        const [conversationResult, bookingResult] = await Promise.all([
          supabase
            .from('unified_conversations')
            .select('id, customer_name')
            .in('id', conversationIds),
          supabase
            .from('bookings')
            .select('conversation_id, booking_date, number_of_people, service:booking_services(name)')
            .in('conversation_id', conversationIds)
            .neq('status', 'cancelled')
            .order('booking_date', { ascending: true }),
        ])

        if (conversationResult.error || bookingResult.error) return unavailable()

        for (const row of (conversationResult.data ?? []) as ConversationRow[]) {
          if (row.customer_name) customerByConversation.set(row.id, row.customer_name)
        }
        for (const row of (bookingResult.data ?? []) as unknown as BookingRow[]) {
          if (!row.conversation_id || bookingByConversation.has(row.conversation_id)) continue
          bookingByConversation.set(row.conversation_id, {
            serviceName: serviceName(row.service),
            bookingDate: row.booking_date,
            numberOfPeople: row.number_of_people,
          })
        }
      }

      const enriched = escalations.map((row) => {
        const booking = row.conversation_id ? bookingByConversation.get(row.conversation_id) ?? null : null
        return {
          ...row,
          booking_meta: booking
            ? {
                service_name: booking.serviceName,
                booking_date: booking.bookingDate,
                number_of_people: booking.numberOfPeople,
              }
            : null,
        }
      })

      const items = sortEscalationsByPriority(enriched).map((row): AttentionCapabilityItem => {
        const briefing = summarizeEscalation(row)
        const booking = row.conversation_id ? bookingByConversation.get(row.conversation_id) ?? null : null
        return {
          id: row.id,
          conversationId: row.conversation_id,
          customerName: row.conversation_id ? customerByConversation.get(row.conversation_id) ?? null : null,
          summary: briefing.body,
          decision: briefing.decision,
          booking,
          createdAt: row.created_at,
        }
      })

      return {
        status: 'observed',
        data: items,
        evidence: items.map((item) => ({ kind: 'record' as const, id: item.id })),
        executionRef: null,
        auditRef: null,
        failure: null,
      }
    } catch {
      return unavailable()
    }
  },
}

function unavailable() {
  return {
    status: 'failed' as const,
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: {
      code: 'unavailable' as const,
      message: 'Attention state could not be read.',
      retryable: true,
    },
  }
}
