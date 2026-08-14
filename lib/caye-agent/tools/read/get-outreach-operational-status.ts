import type { Tool } from '../types'
import { getOutreachOperationalStatus } from '@/lib/outreach-operational-status'

export const getOutreachStatus: Tool<Record<string, never>> = {
  name: 'get_outreach_operational_status',
  description: 'Authoritative current outreach status: pause, cron result, business-day send count/cap, queued work, lead supply, provider health, blockers, and exact zero-send reason. Always call before answering any outreach operations question; never speculate.',
  risk: 'read', roles: ['owner', 'founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx) { return { ok: true, data: await getOutreachOperationalStatus(ctx.workspaceId) } },
}
