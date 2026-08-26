import type { Tool } from './types'
import { gateHighRisk } from './high-risk-gate'
import { HIGH_RISK_TOOLS } from './high-risk-registry'
import {
  cancelPendingExternalDraftsForConversation,
  EXTERNAL_DRAFT_INTENT_REQUIRED,
  verifyExternalDraftIntent,
} from './external-draft-intent'
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
import { getMyAssignments } from './read/get-my-assignments'
import { getLogisticsFacts } from './read/get-logistics-facts'
import { escalateDriverQuestion } from './write-low/escalate-driver-question'
import { getCronHealth } from './admin/read/get-cron-health'
import { getWorkspaceAutonomy } from './admin/read/get-workspace-autonomy'
import { triggerCron } from './admin/write-high/trigger-cron'
import { setWorkspaceAutonomy } from './admin/write-high/set-workspace-autonomy'
import { gateAdminHighRisk } from './admin/admin-high-risk-gate'
import { checkAvailabilityTool } from './read/front-desk/check-availability'
import { lookupPriceTool } from './read/front-desk/lookup-price'
import { findBookingsTool } from './read/front-desk/find-bookings'
import { sendCustomerReply } from './write-high/send-customer-reply'

/**
 * All tools available to the back-office agent.
 *
 * Read tools (11): #38 + #40 — autonomous execution (adds
 * get_channel_status, 2026-08-06 — connect-walkthrough state, derived
 * from connected_accounts rather than stored)
 * Low-risk write tools (21): #37 — autonomous execution (adds
 * remove_business_fact, 2026-07-30 — mirrors add_business_fact so
 * temporary notes like a vacation closure can be retired once stale;
 * update_team_member_name, 2026-07-27 — self-service display name so
 * greetings don't fall back to full_name/legal name; get_connect_link,
 * 2026-08-06 — mints signed channel connect links and hard-refuses
 * WhatsApp when the owner's number is their personal phone, since that
 * migration is destructive and can't be left to prompt text;
 * send_operator_message, 2026-08-16 — the action-grounding incident's
 * missing capability: a real, synchronous WhatsApp send to another
 * authorized operator, low-risk on the same reasoning as
 * schedule_reminder — it can only ever reach an operator, never a guest)
 * High-risk write tools (11): #42/#43 — gated through confirmation flow
 * (adds remove_pricing_tier, 2026-07-26; send_outreach_batch, 2026-08-01 —
 * step 3 of the 2026-07-21 staged-autonomy roadmap, batch-approved
 * first-touch outreach sends; draft_in_inbox, 2026-08-17 — raised from
 * low-risk after it silently redirected an operator to her email instead
 * of showing a draft in chat, see the tool's own doc comment). Listed
 * ungated in high-risk-registry.ts. Plus confirm_pending_action
 * (2026-08-08), which runs a staged action by id and is itself ungated by
 * design.
 * Driver-mode tools (4, 2026-07-05): tagged modes: ['driver'] — never
 * shipped to back-office/front-desk requests, see execute.ts mode filter.
 */
type AnyTool = Tool<never>

const inlineSendReply = HIGH_RISK_TOOLS.find((tool) => tool.name === 'send_reply') as AnyTool | undefined

async function stageInlineDraftFallback(
  args: never,
  ctx: Parameters<AnyTool['execute']>[1]
) {
  if (!inlineSendReply) {
    return { ok: false, error: 'Inline reply drafting is unavailable.' }
  }

  const conversationId = (args as { conversation_id?: unknown }).conversation_id
  if (typeof conversationId === 'string') {
    await cancelPendingExternalDraftsForConversation({ ctx, conversationId })
  }

  return gateHighRisk(inlineSendReply).execute(args, ctx)
}

/**
 * CAY-9 adds two destination-specific protections around the existing
 * high-risk gate without changing the risk model for any other tool.
 *
 * - draft_in_inbox: verify the CURRENT operator turn explicitly chose the
 *   external email artifact before a pending row can even be staged. If the
 *   model picked that tool for an ordinary "draft/revise" turn anyway,
 *   deterministically stage the exact same body through send_reply so the
 *   operator still gets the inline review flow instead of another model guess.
 * - send_reply: when the operator returns to the normal inline draft path,
 *   retire any still-pending external draft for that same customer thread so
 *   a later generic confirmation cannot target the obsolete destination.
 */
function registeredHighRiskTool(tool: AnyTool): AnyTool {
  const gated = gateHighRisk(tool) as AnyTool

  if (tool.name === 'draft_in_inbox') {
    return {
      ...gated,
      async execute(args, ctx) {
        const intentError = await verifyExternalDraftIntent(ctx)
        if (intentError?.error_code === EXTERNAL_DRAFT_INTENT_REQUIRED) {
          return stageInlineDraftFallback(args, ctx)
        }
        if (intentError) return intentError
        return gated.execute(args, ctx)
      },
    }
  }

  if (tool.name === 'send_reply') {
    return {
      ...gated,
      async execute(args, ctx) {
        const conversationId = (args as { conversation_id?: unknown }).conversation_id
        if (typeof conversationId === 'string') {
          await cancelPendingExternalDraftsForConversation({ ctx, conversationId })
        }
        return gated.execute(args, ctx)
      },
    }
  }

  return gated
}

export const TOOL_REGISTRY: AnyTool[] = [
  // Read
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
  // Low-risk write
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
  // High-risk write — confirmation flow enforced in code (gateHighRisk,
  // #64), not just the prompt. See lib/caye-agent/tools/high-risk-gate.ts.
  // The ungated list lives in high-risk-registry.ts because
  // confirm_pending_action needs it too and cannot import this module.
  ...HIGH_RISK_TOOLS.map((t) => registeredHighRiskTool(t as AnyTool)),
  // Confirms a staged action by id (2026-08-08). Deliberately NOT gated —
  // staging a confirmation would itself need confirming, forever. Its own
  // safety comes from the staged row: expiry, execution, cancellation, the
  // different-request rule, and the TARGET tool's role list are all
  // re-checked inside it. See write-high/confirm-pending-action.ts for why
  // confirming by id replaced confirming by re-derived args.
  confirmPendingAction as AnyTool,
  // Driver mode
  getMyAssignments as AnyTool,
  getLogisticsFacts as AnyTool,
  escalateDriverQuestion as AnyTool,
  // Front-desk read-tool slice (2026-08-16, Phase 2 of runtime convergence).
  // Thin adapters over lib/caye-reply.ts's canonical checkAvailability /
  // lookupPriceForCaye / findBookings — no business logic duplicated, no
  // write tools yet (deliberately narrow: proving the observe/reason/tool/
  // observe loop on real booking/pricing data before anything executes).
  // Inert for production today: nothing calls runToolLoop({mode:'front-desk'})
  // without an explicit tools override (see execute.ts), and caye-reply.ts's
  // own tool loop is untouched and continues to serve live customer traffic.
  checkAvailabilityTool as AnyTool,
  lookupPriceTool as AnyTool,
  findBookingsTool as AnyTool,
  // send_customer_reply (2026-08-16, Phase 3): deliberately NOT in
  // HIGH_RISK_TOOLS / NOT wrapped in gateHighRisk — see the tool's own doc
  // comment for why the operator-confirmation-round-trip model doesn't fit
  // an autonomous customer-facing reply. Its own execute() enforces the
  // evidence/disposition gate (evidence.ts) directly, matching how
  // lib/caye-reply.ts already gates production sends today. Still inert
  // for production: nothing wires 'front-desk' mode into a live webhook.
  sendCustomerReply as AnyTool,
  // Admin Shell (2026-07-21) — founder-only dev/ops console, workspace-less.
  // trigger_cron is gated via gateAdminHighRisk (a separate confirmation
  // mechanism from gateHighRisk above, backed by caye_admin_pending_actions
  // rather than caye_pending_actions — see admin-high-risk-gate.ts).
  getCronHealth as AnyTool,
  getWorkspaceAutonomy as AnyTool,
  gateAdminHighRisk(triggerCron) as AnyTool,
  // set_workspace_autonomy is the only way to switch on the opportunity-scan
  // and business-insights crons (both default false in the migration, and
  // nothing in the customer dashboard touches them by design). Gated because
  // enabling a scan points unprompted, recurring WhatsApp traffic at a paying
  // customer's owner — see the tool's own doc comment.
  gateAdminHighRisk(setWorkspaceAutonomy) as AnyTool,
]

export function findTool(name: string): AnyTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name)
}
