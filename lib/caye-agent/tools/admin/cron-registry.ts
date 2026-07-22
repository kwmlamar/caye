import 'server-only'
import { runMorningDigest } from '@/app/api/caye/morning-digest/route'
import { runEscalationFollowup } from '@/app/api/caye/escalation-followup/cron/route'
import { runGmailPoll } from '@/app/api/email/gmail-poll/route'

/**
 * Fixed, hardcoded map of the crons Admin Shell can report on / manually
 * trigger. Deliberately not dynamic — trigger_cron only ever calls one of
 * these three named functions, never an arbitrary path or command. Adding
 * a fourth cron here means writing the code, not something a founder can
 * do from chat.
 */
export const CRON_JOBS: Record<string, { label: string; run: () => Promise<Record<string, unknown>> }> = {
  'morning-digest': { label: 'Morning digest + aging escalations', run: runMorningDigest },
  'escalation-followup': { label: 'Escalation follow-up sweep', run: runEscalationFollowup },
  'gmail-poll': { label: 'Gmail inbox poll', run: runGmailPoll },
}
