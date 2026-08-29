import type { Tool } from './types'
import { createServiceClient } from '@/lib/supabase-server'
import { gateHighRisk } from './high-risk-gate'
import { gateBoundedOutreachTarget } from './outreach-target-authorization'
import { HIGH_RISK_TOOLS } from './high-risk-registry'
import { cancelPendingExternalDraftsForConversation, EXTERNAL_DRAFT_INTENT_REQUIRED, verifyExternalDraftIntent } from './external-draft-intent'
import { updateActiveWork } from '@/lib/whatsapp/active-work'
import { confirmPendingAction } from './write-high/confirm-pending-action'
import { getCalendar } from './read/get-calendar'
import { getZohoCalendar } from './read/get-zoho-calendar'
import { getHeldQueue } from './read/get-held-queue'
import { getTodaySummary } from './read/get-today-summary'
import { getRevenue } from './read/get-revenue'
import { getTourTypePerformance } from './read/get-tour-type-performance'
import { getCustomer } from './read/get-customer'
import { getCustomerHistory } from './read/get-customer-history'
import { getRecentActivity } from './read/get-recent-activity'
import { getRecentInboundTool } from './read/get-recent-inbound'
import { getRecentBookings } from './read/get-recent-bookings'
import { getPendingQuotes } from './read/get-pending-quotes'
import { searchThreads } from './read/search-threads'
import { queryBusinessKnowledge } from './read/query-business-knowledge'
import { listStandingRules } from './read/list-standing-rules'
import { listActiveGoals } from './read/list-active-goals'
import { getServices } from './read/get-services'
import { getTeamMembers } from './read/get-team-members'
import { getChannelStatus } from './read/get-channel-status'
import { getOutreachStatus } from './read/get-outreach-operational-status'
import { getOutreachTargeting } from './read/get-outreach-targeting'
import { getArtifact } from './read/get-artifact'
import { searchArtifacts } from './read/search-artifacts'
import { listPropertiesTool } from './read/list-properties'
import { getPropertySnapshotTool } from './read/get-property-snapshot'
import { analyzePropertyWaterTool } from './read/analyze-property-water'
import { getConnectLink } from './write-low/get-connect-link'
import { recordChannelIntake } from './write-low/record-channel-intake'
import { markHandled } from './write-low/mark-handled'
import { scheduleReminder } from './write-low/schedule-reminder'
import { sendOperatorMessage } from './write-low/send-operator-message'
import { addServiceAvailabilityRule } from './write-low/add-service-availability-rule'
import { addBusinessFact } from './write-low/add-business-fact'
import { confirmFactCandidate } from './write-low/confirm-fact-candidate'
import { dismissFactCandidate } from './write-low/dismiss-fact-candidate'
import { removeBusinessFact } from './write-low/remove-business-fact'
import { addStandingRule } from './write-low/add-standing-rule'
import { removeStandingRule } from './write-low/remove-standing-rule'
import { updateServicePrice } from './write-low/update-service-price'
import { addService } from './write-low/add-service'
import { addPricingTier } from './write-low/add-pricing-tier'
import { setServiceVisibility } from './write-low/set-service-visibility'
import { updateBusinessHours } from './write-low/update-business-hours'
import { addBlackoutDate } from './write-low/add-blackout-date'
import { updateVoiceRegister } from './write-low/update-voice-register'
import { addVoiceSample } from './write-low/add-voice-sample'
import { addTeamMember } from './write-low/add-team-member'
import { createOutreachLeads } from './write-low/create-outreach-leads'
import { runOutreach } from './write-low/run-outreach'
import { recoverOutreachOperations } from './write-low/recover-outreach-operations'
import { updateTeamMemberPermissions } from './write-low/update-team-member-permissions'
import { updateTeamMemberName } from './write-low/update-team-member-name'
import { switchWorkspace } from './write-low/switch-workspace'
import { skipHeldItem } from './write-low/skip-held-item'
import { muteCaye } from './write-low/mute-caye'
import { unmuteCaye } from './write-low/unmute-caye'
import { archiveThread } from './write-low/archive-thread'
import { addInternalNote } from './write-low/add-internal-note'
import { sendPaymentConfirmation } from './write-low/send-payment-confirmation'
import { notifyDriver } from './write-low/notify-driver'
import { relateToDirectThread } from './write-low/relate-to-direct-thread'
import { annotateArtifactTool } from './write-low/annotate-artifact'
import { retrieveArtifactForOperator } from './write-low/retrieve-artifact-for-operator'
import { createPropertyTool } from './write-low/create-property'
import { addPropertyStructureTool } from './write-low/add-property-structure'
import { addPropertySystemTool } from './write-low/add-property-system'
import { addPropertyAssetTool } from './write-low/add-property-asset'
import { recordPropertyObservationTool } from './write-low/record-property-observation'
import { getMyAssignments } from './read/get-my-assignments'
import { getLogisticsFacts } from './read/get-logistics-facts'
import { escalateDriverQuestion } from './write-low/escalate-driver-question'
import { getCronHealth } from './admin/read/get-cron-health'
import { getWorkspaceAutonomy } from './admin/read/get-workspace-autonomy'
import { triggerCron } from './admin/write-high/trigger-cron'
import { setWorkspaceAutonomy } from './admin/write-high/set-workspace-autonomy'
import { gateAdminHighRisk } from './admin/admin-high-risk-gate'
import { getJobSearchSummary } from './admin/read/get-job-search-summary'
import { listJobSearchQueue } from './admin/read/list-job-search-queue'
import { listJobSearchCandidates } from './admin/read/list-job-search-candidates'
import { explainJobSearchRejection } from './admin/read/explain-job-search-rejection'
import { pauseJobSearch } from './admin/write-low/pause-job-search'
import { resumeJobSearch } from './admin/write-low/resume-job-search'
import { listApplicationsNeedingReview } from './admin/read/list-applications-needing-review'
import { explainApplicationStatus } from './admin/read/explain-application-status'
import { getApplicationSubmissionEvidence } from './admin/read/get-application-submission-evidence'
import { getExecutionDailySummary } from './admin/read/get-execution-daily-summary'
import { pauseApplicationExecution } from './admin/write-low/pause-application-execution'
import { resumeApplicationExecution } from './admin/write-low/resume-application-execution'
import { enableDryRunMode } from './admin/write-low/enable-dry-run-mode'
import { disableApplicationAutomation } from './admin/write-low/disable-application-automation'
import { enableApplicationAutomation } from './admin/write-high/enable-application-automation'
import { disableDryRunMode } from './admin/write-high/disable-dry-run-mode'
import { setDailySubmissionCap } from './admin/write-high/set-daily-submission-cap'
import { checkAvailabilityTool } from './read/front-desk/check-availability'
import { lookupPriceTool } from './read/front-desk/lookup-price'
import { findBookingsTool } from './read/front-desk/find-bookings'
import { sendCustomerReply } from './write-high/send-customer-reply'
import { createParametricPart } from './write-low/create-parametric-part'
import { reviseParametricPart } from './write-low/revise-parametric-part'
import { runStaticStructuralAnalysis } from './write-low/run-static-structural-analysis'
import { rerunStaticStructuralAnalysis } from './write-low/rerun-static-structural-analysis'
import {
  listEngineeringProjectsTool,
  getEngineeringProjectTool,
  createEngineeringProjectTool,
  establishEngineeringBaselineTool,
  addEngineeringAlternativeTool,
  selectEngineeringAlternativeTool,
  recordEngineeringExecutionTool,
  linkEngineeringOutcomeTool,
  compareEngineeringProjectOutcomesTool,
  recordEngineeringVerdictTool,
} from '@/lib/engineering-projects/tools'

type AnyTool = Tool<never>
const inlineSendReply = HIGH_RISK_TOOLS.find((tool) => tool.name === 'send_reply') as AnyTool | undefined

async function stageInlineDraftFallback(args: never, ctx: Parameters<AnyTool['execute']>[1]) {
  if (!inlineSendReply) return { ok: false, error: 'Inline reply drafting is unavailable.' }
  const conversationId = (args as { conversation_id?: unknown }).conversation_id
  if (typeof conversationId === 'string') await cancelPendingExternalDraftsForConversation({ ctx, conversationId })
  return gateHighRisk(inlineSendReply).execute(args, ctx)
}

function registeredHighRiskTool(tool: AnyTool): AnyTool {
  const gated = (tool.name === 'expand_outreach_target'
    ? gateBoundedOutreachTarget(tool)
    : gateHighRisk(tool)) as AnyTool
  if (tool.name === 'draft_in_inbox') {
    return { ...gated, async execute(args, ctx) {
      const intentError = await verifyExternalDraftIntent(ctx)
      if (intentError?.error_code === EXTERNAL_DRAFT_INTENT_REQUIRED) return stageInlineDraftFallback(args, ctx)
      if (intentError) return intentError
      return gated.execute(args, ctx)
    } }
  }
  if (tool.name === 'send_reply') {
    return { ...gated, async execute(args, ctx) {
      const conversationId = (args as { conversation_id?: unknown }).conversation_id
      if (typeof conversationId === 'string') await cancelPendingExternalDraftsForConversation({ ctx, conversationId })
      const result = await gated.execute(args, ctx)
      const body = (args as { body?: unknown }).body
      if (typeof body === 'string' && body.trim()) {
        const data = result.data as { executed?: unknown } | undefined
        await updateActiveWork({ supabase: createServiceClient(), workspaceId: ctx.workspaceId, operatorId: ctx.operatorId, work: ctx.activeWork, artifact: body.trim(), status: result.ok && data?.executed !== true ? 'ready' : result.ok ? 'completed' : 'failed' })
      }
      return result
    } }
  }
  return gated
}

export const TOOL_REGISTRY: AnyTool[] = [
  getCalendar as AnyTool,
  getZohoCalendar as AnyTool,
  getHeldQueue as AnyTool,
  getTodaySummary as AnyTool,
  getRevenue as AnyTool,
  getTourTypePerformance as AnyTool,
  getCustomer as AnyTool,
  getCustomerHistory as AnyTool,
  getRecentActivity as AnyTool,
  getRecentInboundTool as AnyTool,
  getRecentBookings as AnyTool,
  getPendingQuotes as AnyTool,
  searchThreads as AnyTool,
  queryBusinessKnowledge as AnyTool,
  listStandingRules as AnyTool,
  listActiveGoals as AnyTool,
  getServices as AnyTool,
  getTeamMembers as AnyTool,
  getChannelStatus as AnyTool,
  getOutreachStatus as AnyTool,
  getOutreachTargeting as AnyTool,
  getArtifact as AnyTool,
  searchArtifacts as AnyTool,
  listPropertiesTool as AnyTool,
  getPropertySnapshotTool as AnyTool,
  analyzePropertyWaterTool as AnyTool,
  listEngineeringProjectsTool as AnyTool,
  getEngineeringProjectTool as AnyTool,
  compareEngineeringProjectOutcomesTool as AnyTool,
  getConnectLink as AnyTool,
  recordChannelIntake as AnyTool,
  markHandled as AnyTool,
  scheduleReminder as AnyTool,
  sendOperatorMessage as AnyTool,
  addServiceAvailabilityRule as AnyTool,
  addBusinessFact as AnyTool,
  confirmFactCandidate as AnyTool,
  dismissFactCandidate as AnyTool,
  removeBusinessFact as AnyTool,
  addStandingRule as AnyTool,
  removeStandingRule as AnyTool,
  updateServicePrice as AnyTool,
  addService as AnyTool,
  addPricingTier as AnyTool,
  setServiceVisibility as AnyTool,
  updateBusinessHours as AnyTool,
  addBlackoutDate as AnyTool,
  updateVoiceRegister as AnyTool,
  addVoiceSample as AnyTool,
  addTeamMember as AnyTool,
  updateTeamMemberPermissions as AnyTool,
  updateTeamMemberName as AnyTool,
  switchWorkspace as AnyTool,
  skipHeldItem as AnyTool,
  muteCaye as AnyTool,
  unmuteCaye as AnyTool,
  archiveThread as AnyTool,
  addInternalNote as AnyTool,
  sendPaymentConfirmation as AnyTool,
  notifyDriver as AnyTool,
  createOutreachLeads as AnyTool,
  runOutreach as AnyTool,
  recoverOutreachOperations as AnyTool,
  relateToDirectThread as AnyTool,
  annotateArtifactTool as AnyTool,
  retrieveArtifactForOperator as AnyTool,
  createPropertyTool as AnyTool,
  addPropertyStructureTool as AnyTool,
  addPropertySystemTool as AnyTool,
  addPropertyAssetTool as AnyTool,
  recordPropertyObservationTool as AnyTool,
  createEngineeringProjectTool as AnyTool,
  establishEngineeringBaselineTool as AnyTool,
  addEngineeringAlternativeTool as AnyTool,
  selectEngineeringAlternativeTool as AnyTool,
  recordEngineeringExecutionTool as AnyTool,
  linkEngineeringOutcomeTool as AnyTool,
  recordEngineeringVerdictTool as AnyTool,
  createParametricPart as AnyTool,
  reviseParametricPart as AnyTool,
  runStaticStructuralAnalysis as AnyTool,
  rerunStaticStructuralAnalysis as AnyTool,
  ...HIGH_RISK_TOOLS.map((t) => registeredHighRiskTool(t as AnyTool)),
  confirmPendingAction as AnyTool,
  getMyAssignments as AnyTool,
  getLogisticsFacts as AnyTool,
  escalateDriverQuestion as AnyTool,
  checkAvailabilityTool as AnyTool,
  lookupPriceTool as AnyTool,
  findBookingsTool as AnyTool,
  sendCustomerReply as AnyTool,
  getCronHealth as AnyTool,
  getWorkspaceAutonomy as AnyTool,
  gateAdminHighRisk(triggerCron) as AnyTool,
  gateAdminHighRisk(setWorkspaceAutonomy) as AnyTool,
  // CAY-192 — founder-only job-search operator (Phase 7 founder UX).
  // pause/resume are 'low' risk, not gateAdminHighRisk-wrapped: pausing
  // is safety-positive/immediate, and resuming only re-enables
  // application PREPARATION, which always lands at NEEDS_HUMAN in this
  // build (no automated submission exists yet — see
  // lib/job-search/application-executor.ts's doc comment).
  getJobSearchSummary as AnyTool,
  listJobSearchQueue as AnyTool,
  listJobSearchCandidates as AnyTool,
  explainJobSearchRejection as AnyTool,
  pauseJobSearch as AnyTool,
  resumeJobSearch as AnyTool,
  // CAY-194 — real ATS application-submission execution (follow-up to
  // CAY-192). Read tools + low-risk safety switches are unwrapped;
  // anything that makes execution MORE capable of a real submission
  // (enabling automation, disabling dry-run, changing the daily cap) is
  // gateAdminHighRisk-wrapped, same confirmation mechanism as
  // set_workspace_autonomy above.
  listApplicationsNeedingReview as AnyTool,
  explainApplicationStatus as AnyTool,
  getApplicationSubmissionEvidence as AnyTool,
  getExecutionDailySummary as AnyTool,
  pauseApplicationExecution as AnyTool,
  resumeApplicationExecution as AnyTool,
  enableDryRunMode as AnyTool,
  disableApplicationAutomation as AnyTool,
  gateAdminHighRisk(enableApplicationAutomation) as AnyTool,
  gateAdminHighRisk(disableDryRunMode) as AnyTool,
  gateAdminHighRisk(setDailySubmissionCap) as AnyTool,
]

export function findTool(name: string): AnyTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name)
}
