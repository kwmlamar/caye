import 'server-only'
import { decisionSubjectKey, requiredAuthorityForDomain, routeBusinessDecision, type DecisionDomain, type DecisionRisk } from '@/lib/decision-authority'
import type { Tool } from '../types'

type Input = {
  domain: DecisionDomain
  summary: string
  subject_key?: string
  risk?: DecisionRisk
  objective_run_id?: string
  objective_step_key?: string
}

const DOMAINS: DecisionDomain[] = [
  'booking_capacity',
  'booking_management',
  'payment_policy',
  'customer_communication',
  'outreach_control',
  'service_policy',
  'team_management',
  'business_policy',
  'routing_admin',
]

export const requestBusinessDecision: Tool<Input> = {
  name: 'request_business_decision',
  description: `Route a business decision to whoever actually holds the required workspace authority. Use this instead of asking the person currently talking to you merely because they initiated the conversation. The tool deterministically maps the decision domain to an authority scope, resolves verified authorized principals, persists the pending decision, and attempts safe delivery. If the current actor is the authorized decision owner, it tells you to ask them directly. Never choose an approver yourself and never substitute founder/platform-admin status for customer business authority.`,
  risk: 'low',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', enum: DOMAINS, description: 'Business decision domain. This maps deterministically to the required authority scope.' },
      summary: { type: 'string', description: 'A concise, decision-ready description containing enough context for the authorized person to decide without opening another thread.' },
      subject_key: { type: 'string', description: 'Optional stable business subject key. Omit to derive one from domain + summary.' },
      risk: { type: 'string', enum: ['routine', 'consequential', 'high'] },
      objective_run_id: { type: 'string', description: 'Optional durable objective run to resume once a decision is recorded.' },
      objective_step_key: { type: 'string', description: 'Optional blocked objective step paired with objective_run_id.' },
    },
    required: ['domain', 'summary'],
  },
  async execute(args, ctx) {
    const summary = args.summary?.trim()
    if (!summary) return { ok: false, error: 'A decision-ready summary is required.' }
    if (!DOMAINS.includes(args.domain)) return { ok: false, error: 'Unknown decision domain; authority cannot be guessed.' }
    const subjectKey = args.subject_key?.trim() || decisionSubjectKey([args.domain, summary])
    const resumeLink = args.objective_run_id && args.objective_step_key
      ? { objectiveRunId: args.objective_run_id, stepKey: args.objective_step_key }
      : null
    const routed = await routeBusinessDecision({
      ctx,
      domain: args.domain,
      risk: args.risk ?? 'consequential',
      subjectKey,
      summary,
      resumeLink,
      evidence: { source: 'request_business_decision', requiredAuthority: requiredAuthorityForDomain(args.domain) },
    })
    return routed.result
  },
}
