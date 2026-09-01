import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { isPositiveResponse, type ResponseClassification } from './response-classification'

const MAX_FOUNDER_FOLLOWUP_REMINDERS = 2
const FIRST_REMINDER_DELAY_MS = 24 * 60 * 60 * 1000

export async function queueFounderFollowupReminder(input: {
  applicationId: string
  classification: ResponseClassification
  receivedAt: string
}): Promise<'queued' | 'not_actionable' | 'already_pending' | 'limit_reached'> {
  if (!isPositiveResponse(input.classification)) return 'not_actionable'

  const supabase = createServiceClient()
  const { data: existing, error } = await supabase
    .from('job_search_followups')
    .select('id, completed_at')
    .eq('application_id', input.applicationId)
    .eq('followup_type', 'follow_up_nudge')

  if (error) throw new Error(`Could not inspect founder follow-ups: ${error.message}`)

  const reminders = existing ?? []
  if (reminders.length >= MAX_FOUNDER_FOLLOWUP_REMINDERS) return 'limit_reached'
  if (reminders.some((row) => !row.completed_at)) return 'already_pending'

  const receivedAt = new Date(input.receivedAt)
  const dueAt = new Date(receivedAt.getTime() + FIRST_REMINDER_DELAY_MS).toISOString()
  const { error: insertError } = await supabase.from('job_search_followups').insert({
    application_id: input.applicationId,
    followup_type: 'follow_up_nudge',
    direction: 'OUTBOUND',
    due_at: dueAt,
    note: `Founder review reminder after ${input.classification}; no external message has been sent.`,
  })

  if (insertError) throw new Error(`Could not queue founder follow-up reminder: ${insertError.message}`)
  return 'queued'
}
