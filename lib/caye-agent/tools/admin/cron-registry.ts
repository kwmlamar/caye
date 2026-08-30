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
import { runJobSearchSourcing } from '@/app/api/caye/job-search-sourcing/route'
import { runJobSearchPreparation } from '@/app/api/caye/job-search-prepare/route'
import { runJobSearchInspection } from '@/app/api/caye/job-search-inspect/route'
import { runResearchWorker } from '@/app/api/caye/research-worker/route'
import { runGrowthIngest } from '@/app/api/caye/growth-ingest/route'

/** Fixed allowlist of jobs Admin Shell may inspect/trigger. */
export const CRON_JOBS: Record<
  string,
  { label: string; run: (opts?: { force?: boolean }) => Promise<Record<string, unknown>> }
> = {
  'morning-digest': { label: 'Morning digest + aging escalations', run: runMorningDigest },
  'escalation-followup': { label: 'Escalation follow-up sweep', run: runEscalationFollowup },
  'gmail-poll': { label: 'Gmail inbox poll', run: runGmailPoll },
  'template-sync': { label: 'WhatsApp template sync (Meta → whatsapp_templates)', run: runTemplateSync },
  'opportunity-scan': { label: 'Proactive workspace scan (3x/day, opted-in workspaces)', run: runOpportunityScan },
  'business-insights': { label: 'Weekly business-insights read-out (opted-in workspaces)', run: runBusinessInsights },
  'activation-scan': { label: 'Zero-channel signups (alerts founder, once per workspace)', run: runActivationScan },
  'operation-worker': { label: 'External-effects outbox (deferred calendar syncs)', run: runOperationWorker },
  'outreach-autosend-scan': { label: 'Outreach send scan', run: runOutreachAutosendScan },
  'outreach-sourcing-scan': { label: 'Outreach sourcing scan', run: runOutreachSourcingScan },
  'job-search-sourcing': { label: 'Job-search sourcing/scoring (founder-only)', run: runJobSearchSourcing },
  'job-search-prepare': { label: 'Job-search application preparation (founder-only, no submission)', run: runJobSearchPreparation },
  'job-search-inspect': { label: 'Inspect prepared ATS forms and resolve known answers (founder-only, no submission)', run: runJobSearchInspection },
  'research-worker': { label: 'Founder research queue worker (evidence-backed)', run: runResearchWorker },
  'growth-ingest': { label: 'Growth Intelligence provider ingestion (read-only external data)', run: runGrowthIngest },
}
