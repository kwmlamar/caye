import 'server-only'
import { runMorningDigest } from '@/app/api/caye/morning-digest/route'
import { runEscalationFollowup } from '@/app/api/caye/escalation-followup/cron/route'
import { runGmailPoll } from '@/app/api/email/gmail-poll/route'
import { runTemplateSync } from '@/app/api/caye/template-sync/cron/route'
import { runOpportunityScan } from '@/app/api/caye/opportunity-scan/cron/route'
import { runBusinessInsights } from '@/app/api/caye/business-insights/cron/route'

/**
 * Fixed, hardcoded map of the crons Admin Shell can report on / manually
 * trigger. Deliberately not dynamic — trigger_cron only ever calls one of
 * these named functions, never an arbitrary path or command. Adding
 * another cron here means writing the code, not something a founder can
 * do from chat.
 */
export const CRON_JOBS: Record<string, { label: string; run: () => Promise<Record<string, unknown>> }> = {
  'morning-digest': { label: 'Morning digest + aging escalations', run: runMorningDigest },
  'escalation-followup': { label: 'Escalation follow-up sweep', run: runEscalationFollowup },
  'gmail-poll': { label: 'Gmail inbox poll', run: runGmailPoll },
  'template-sync': { label: 'WhatsApp template sync (Meta → whatsapp_templates)', run: runTemplateSync },
  // Both are per-workspace opt-in (workspace_ai_config.*_enabled, default
  // false) and self-skip outside their target local hours, so triggering
  // either by hand is how you actually exercise one without waiting for the
  // schedule — it still only touches workspaces the founder has enabled.
  'opportunity-scan': { label: 'Proactive workspace scan (3x/day, opted-in workspaces)', run: runOpportunityScan },
  'business-insights': { label: 'Weekly business-insights read-out (opted-in workspaces)', run: runBusinessInsights },
}
