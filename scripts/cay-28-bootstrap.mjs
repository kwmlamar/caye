import fs from 'node:fs'

function read(path) { return fs.readFileSync(path, 'utf8') }
function write(path, value) { fs.writeFileSync(path, value) }
function replaceOnce(path, from, to) {
  const source = read(path)
  const count = source.split(from).length - 1
  if (count !== 1) throw new Error(`${path}: expected exactly one match, found ${count}: ${from.slice(0, 100)}`)
  write(path, source.replace(from, to))
}

// Fix the canonical owner-attention API call shape.
replaceOnce(
  'lib/decision-authority.ts',
  "      await markAttentionNotified(input.workspaceId, attention.id, message).catch(() => undefined)",
  "      await markAttentionNotified({ workspaceId: input.ctx.workspaceId, subjectType: 'decision', subjectId: input.subjectKey, summary: message }).catch(() => undefined)"
)

// Register the three canonical decision tools without creating a second registry.
replaceOnce(
  'lib/caye-agent/tools/registry.ts',
  "import { getOutreachTargeting } from './read/get-outreach-targeting'",
  "import { getOutreachTargeting } from './read/get-outreach-targeting'\nimport { getPendingBusinessDecisions } from './read/get-pending-business-decisions'"
)
replaceOnce(
  'lib/caye-agent/tools/registry.ts',
  "import { recoverOutreachOperations } from './write-low/recover-outreach-operations'",
  "import { recoverOutreachOperations } from './write-low/recover-outreach-operations'\nimport { requestBusinessDecision } from './write-low/request-business-decision'\nimport { recordBusinessDecision } from './write-low/record-business-decision'"
)
replaceOnce(
  'lib/caye-agent/tools/registry.ts',
  "  getOutreachTargeting as AnyTool,",
  "  getOutreachTargeting as AnyTool,\n  getPendingBusinessDecisions as AnyTool,"
)
replaceOnce(
  'lib/caye-agent/tools/registry.ts',
  "  recoverOutreachOperations as AnyTool,",
  "  recoverOutreachOperations as AnyTool,\n  requestBusinessDecision as AnyTool,\n  recordBusinessDecision as AnyTool,"
)

// High-risk actions: resolve who may approve BEFORE the existing structural
// confirmation gate scopes its pending action to an operator.
replaceOnce(
  'lib/caye-agent/tools/high-risk-gate.ts',
  "import { claimConversationExecution, releaseConversationExecution } from '@/lib/conversation-execution'",
  "import { claimConversationExecution, releaseConversationExecution } from '@/lib/conversation-execution'\nimport { classifyHighRiskDecision, decisionSubjectKey, requiredAuthorityForDomain, resolveWorkspaceDecisionAuthority, routeBusinessDecision, type DecisionAuthorityResolution, type DecisionDomain } from '@/lib/decision-authority'"
)
replaceOnce(
  'lib/caye-agent/tools/high-risk-gate.ts',
  "      const summary = await describePendingAction(supabase, tool.name, args as Record<string, unknown>)\n\n      if (existing) {",
  `      const summary = await describePendingAction(supabase, tool.name, args as Record<string, unknown>)
      const decisionDomain: DecisionDomain | null = classifyHighRiskDecision(tool.name)
      let decisionAuthority: DecisionAuthorityResolution | null = null
      let approvalOperatorId = ctx.operatorId ?? null
      if (decisionDomain) {
        decisionAuthority = await resolveWorkspaceDecisionAuthority({
          workspaceId: ctx.workspaceId,
          actorOperatorId: ctx.operatorId,
          requiredAuthority: requiredAuthorityForDomain(decisionDomain),
        })
        if (!decisionAuthority.actorAuthorized) {
          approvalOperatorId = decisionAuthority.preferredDecisionOwner?.id ?? null
          if (approvalOperatorId == null) {
            const unresolved = await routeBusinessDecision({
              ctx,
              domain: decisionDomain,
              risk: 'high',
              subjectKey: decisionSubjectKey([tool.name, argsKey]),
              summary,
              resolution: decisionAuthority,
              evidence: { source: 'high_risk_gate', toolName: tool.name, argsKey },
            })
            return unresolved.result
          }
        }
      }

      // Re-scope the existing lookup to the actual decision owner when the
      // conversation actor is not authorized. The query was built above
      // before authority resolution, so rebuild only that narrow case.
      if (decisionAuthority && !decisionAuthority.actorAuthorized && approvalOperatorId != null) {
        let ownerQuery = supabase
          .from('caye_pending_actions')
          .select('id, created_in_request_id, execution_claim_id')
          .eq('workspace_id', ctx.workspaceId)
          .eq('tool_name', tool.name)
          .eq('args_key', argsKey)
          .is('executed_at', null)
          .is('cancelled_at', null)
          .gt('expires_at', nowISO)
          .eq('operator_id', approvalOperatorId)
        const ownerExisting = await ownerQuery.order('created_at', { ascending: false }).limit(1).maybeSingle()
        existing = ownerExisting
      }

      if (existing) {
        if (decisionDomain && decisionAuthority && !decisionAuthority.actorAuthorized) {
          const routed = await routeBusinessDecision({
            ctx,
            domain: decisionDomain,
            risk: 'high',
            subjectKey: decisionSubjectKey([tool.name, argsKey]),
            summary,
            resolution: decisionAuthority,
            evidence: { source: 'high_risk_gate', toolName: tool.name, argsKey, pendingActionId: existing.id },
          })
          return { ...routed.result, data: { ...(routed.result.data as Record<string, unknown> ?? {}), pending_action_id: existing.id } }
        }`
)
// The original first lookup remains actor-scoped, but routed fresh staging and
// supersession must be scoped to the resolved approver.
replaceOnce(
  'lib/caye-agent/tools/high-risk-gate.ts',
  "        staleQuery =\n          ctx.operatorId != null\n            ? staleQuery.eq('operator_id', ctx.operatorId)\n            : staleQuery.is('operator_id', null)",
  "        staleQuery =\n          approvalOperatorId != null\n            ? staleQuery.eq('operator_id', approvalOperatorId)\n            : staleQuery.is('operator_id', null)"
)
replaceOnce(
  'lib/caye-agent/tools/high-risk-gate.ts',
  "        operator_id: ctx.operatorId ?? null,",
  "        operator_id: approvalOperatorId,"
)
replaceOnce(
  'lib/caye-agent/tools/high-risk-gate.ts',
  "      return {\n        ok: true,\n        data: {\n          pending: true,\n          executed: false,\n          status: 'awaiting_operator_confirmation',\n          pending_action_id: pendingActionId,\n          summary,",
  `      if (decisionDomain && decisionAuthority && !decisionAuthority.actorAuthorized) {
        const routed = await routeBusinessDecision({
          ctx,
          domain: decisionDomain,
          risk: 'high',
          subjectKey: decisionSubjectKey([tool.name, argsKey]),
          summary,
          resolution: decisionAuthority,
          evidence: { source: 'high_risk_gate', toolName: tool.name, argsKey, pendingActionId },
        })
        return { ...routed.result, data: { ...(routed.result.data as Record<string, unknown> ?? {}), pending_action_id: pendingActionId, summary } }
      }

      return {
        ok: true,
        data: {
          pending: true,
          executed: false,
          status: 'awaiting_operator_confirmation',
          pending_action_id: pendingActionId,
          summary,`
)

// Legacy pending actions created before CAY-28 also fail closed and transfer
// confirmation ownership to the currently authorized business principal.
replaceOnce(
  'lib/caye-agent/tools/write-high/confirm-pending-action.ts',
  "import { assertConversationOwnedByWorkspace } from '../write-low/_guards'",
  "import { assertConversationOwnedByWorkspace } from '../write-low/_guards'\nimport { classifyHighRiskDecision, decisionSubjectKey, requiredAuthorityForDomain, resolveWorkspaceDecisionAuthority, routeBusinessDecision } from '@/lib/decision-authority'"
)
replaceOnce(
  'lib/caye-agent/tools/write-high/confirm-pending-action.ts',
  "    if (!tool.roles.includes(ctx.callerRole)) {\n      return {\n        ok: false,\n        error: `Tool '${tool.name}' is not available to role '${ctx.callerRole}'. Permitted roles: ${tool.roles.join(', ')}.`,\n      }\n    }\n\n    // The claim acquired while staging is the operator's ownership token.",
  `    if (!tool.roles.includes(ctx.callerRole)) {
      return {
        ok: false,
        error: \`Tool '\${tool.name}' is not available to role '\${ctx.callerRole}'. Permitted roles: \${tool.roles.join(', ')}.\`,
      }
    }

    const decisionDomain = classifyHighRiskDecision(row.tool_name as string)
    if (decisionDomain) {
      const authority = await resolveWorkspaceDecisionAuthority({
        workspaceId: ctx.workspaceId,
        actorOperatorId: ctx.operatorId,
        requiredAuthority: requiredAuthorityForDomain(decisionDomain),
      })
      if (!authority.actorAuthorized) {
        if (authority.preferredDecisionOwner) {
          await supabase
            .from('caye_pending_actions')
            .update({ operator_id: authority.preferredDecisionOwner.id })
            .eq('id', row.id)
            .eq('workspace_id', ctx.workspaceId)
            .is('executed_at', null)
            .is('cancelled_at', null)
        }
        const routed = await routeBusinessDecision({
          ctx,
          domain: decisionDomain,
          risk: 'high',
          subjectKey: decisionSubjectKey(['legacy-pending-action', row.id]),
          summary: row.summary as string,
          resolution: authority,
          evidence: { source: 'confirm_pending_action', pendingActionId: row.id, toolName: row.tool_name },
        })
        return routed.result
      }
    }

    // The claim acquired while staging is the operator's ownership token.`
)

// Outreach recovery is intentionally low-risk operationally, but deciding to
// lift an owner-created business pause is a business-policy decision.
replaceOnce(
  'lib/caye-agent/tools/write-low/recover-outreach-operations.ts',
  "import type { Tool } from '../types'",
  "import type { Tool } from '../types'\nimport { decisionSubjectKey, requiredAuthorityForDomain, resolveWorkspaceDecisionAuthority, routeBusinessDecision } from '@/lib/decision-authority'"
)
replaceOnce(
  'lib/caye-agent/tools/write-low/recover-outreach-operations.ts',
  "  async execute(_args, ctx) {\n    const before = await getOutreachOperationalStatus(ctx.workspaceId)",
  `  async execute(_args, ctx) {
    const authority = await resolveWorkspaceDecisionAuthority({
      workspaceId: ctx.workspaceId,
      actorOperatorId: ctx.operatorId,
      requiredAuthority: requiredAuthorityForDomain('outreach_control'),
    })
    if (!authority.actorAuthorized) {
      const routed = await routeBusinessDecision({
        ctx,
        domain: 'outreach_control',
        risk: 'consequential',
        subjectKey: decisionSubjectKey(['recover_outreach_operations', ctx.workspaceId]),
        summary: 'Resume owner-paused outreach toward the configured first-touch target.',
        resolution: authority,
        evidence: { source: 'recover_outreach_operations', resumeTool: 'recover_outreach_operations' },
      })
      return routed.result
    }
    const before = await getOutreachOperationalStatus(ctx.workspaceId)`
)

// Prompt policy: tool access is not decision authority. This specifically
// removes the production-confusing claim that founder has owner's powers.
replaceOnce(
  'lib/caye-agent/modes/back-office.ts',
  "      `- ${speaker} has full operator powers on this workspace via founder role — same tool access as ${operator} — but treat them as a distinct person.`",
  "      `- ${speaker} has platform-side support and observability tool access, but that does NOT make them the business decision owner. For pricing, payment policy, booking/capacity exceptions, outreach policy, customer commitments, or other consequential business decisions, use the canonical decision-routing tools/gates. If authority data says ${operator} or a delegate owns the decision, route it there and tell ${speaker} who owns it; never ask ${speaker} to approve merely because they opened this conversation.`"
)
replaceOnce(
  'lib/caye-agent/modes/back-office.ts',
  "    `- ESCALATE only when the decision commits money ${speaker} hasn't pre-authorised, sets a precedent (pricing, policy, a discount), is irreversible and consequential, needs something only ${speaker} knows, or one of their standing rules says to. Everything else you handle and mention in passing.`,",
  "    `- ESCALATE only when the decision commits money not already authorised, sets a precedent (pricing, policy, a discount), is irreversible and consequential, needs knowledge only an authorized decision owner has, or a standing rule requires it. Conversation initiator is not authority. Use request_business_decision when a decision is needed; if a gated tool says it routed the decision, tell the current speaker who owns it and what Caye is doing, then stop asking them for approval.`,"
)

console.log('CAY-28 source patches applied')
