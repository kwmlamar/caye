import 'server-only'
import { runMorningDigest } from '@/app/api/caye/morning-digest/route'
import { runEscalationFollowup } from '@/app/api/caye/escalation-followup/cron/route'
import { runGmailPoll } from '@/app/api/email/gmail-poll/route'
import { runTemplateSync } from '@/app/api/caye/template-sync/cron/route'
import { runOpportunityScan } from '@/app/api/caye/opportunity-scan/cron/route'
import { runBusinessInsights } from '@/app/api/caye/business-insights/cron/route'
import { runActivationScan } from '@/app/api/caye/activation-scan/cron/route'
import { runOperationWorker } from '@/app/api/caye/operation-worker/route'
import { runOutreachAutosendScan } from '@/app/api/caye/outreach-autosend-scan/route'
import { runOutreachSourcingScan } from '@/app/api/caye/outreach-sourcing-scan/route'

/**
 * Fixed, hardcoded map of the crons Admin Shell can report on / manually
 * trigger. Deliberately not dynamic — trigger_cron only ever calls one of
 * these named functions, never an arbitrary path or command. Adding
 * another cron here means writing the code, not something a founder can
 * do from chat.
 */
// `force` is only meaningful to opportunity-scan/business-insights (bypasses
// their cadence gate — see the doc comment on runOpportunityScan). The other
// four jobs' run() signatures take no params, which TS allows here since a
// function accepting fewer args satisfies a type expecting more — trigger_cron
// passes force uniformly and jobs that don't use it just ignore it.
export const CRON_JOBS: Record<
  string,
  { label: string; run: (opts?: { force?: boolean }) => Promise<Record<string, unknown>> }
> = {
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
  // Alerts the founder about signups that connected nothing at all. Safe
  // to trigger by hand — it dedupes per workspace forever, so a manual run
  // can't re-alert anyone already flagged.
  'activation-scan': { label: 'Zero-channel signups (alerts founder, once per workspace)', run: runActivationScan },
  // Drains caye_pending_operations (deferred Zoho calendar syncs). Already
  // runs on every outbound-worker tick, so this entry is for forcing a drain
  // by hand — useful right after Zoho comes back up rather than waiting out
  // the backoff. Idempotent: each row's key is unique, so a manual trigger
  // can't double-apply anything.
  'operation-worker': { label: 'External-effects outbox (deferred calendar syncs)', run: runOperationWorker },
  'outreach-autosend-scan': { label: 'Outreach send scan', run: runOutreachAutosendScan },
  'outreach-sourcing-scan': { label: 'Outreach sourcing scan', run: runOutreachSourcingScan },
}
