import 'server-only'
import type { Tool, ToolContext, ToolResult } from './types'

/**
 * dry-run.ts
 *
 * PHASE 1 of runtime convergence. Action-interception for the replay
 * harness: any tool riskier than `'read'` never actually executes when
 * wrapped here — it's recorded as a proposed action instead, and a
 * synthetic-but-honest `ToolResult` is returned so the model's own
 * reasoning continuity isn't broken (it "sees" a plausible staged outcome,
 * the same shape `gateHighRisk` already returns on a first call — see
 * `lib/caye-agent/tools/high-risk-gate.ts`), while nothing is sent,
 * written, charged, or mutated.
 *
 * Read tools are NOT wrapped. They're side-effect-free by the project's
 * own risk taxonomy (`ToolRisk = 'read' | 'low' | 'high'`, `types.ts`),
 * and the replay harness needs real reads to reason about a real
 * historical situation — wrapping them too would make the harness
 * evaluate against fabricated data instead of the thing it's replaying.
 */

export interface ProposedAction {
  toolName: string
  risk: string
  args: unknown
  recordedAt: string
}

export interface DryRunCollector {
  readonly proposedActions: ProposedAction[]
}

export function createDryRunCollector(): DryRunCollector {
  return { proposedActions: [] }
}

export function wrapToolsForDryRun<T>(tools: ReadonlyArray<Tool<T>>, collector: DryRunCollector): Tool<T>[] {
  return tools.map((tool) => {
    if (tool.risk === 'read') return tool
    return {
      ...tool,
      async execute(args: T, _ctx: ToolContext): Promise<ToolResult> {
        collector.proposedActions.push({
          toolName: tool.name,
          risk: tool.risk,
          args,
          recordedAt: new Date().toISOString(),
        })
        return {
          ok: true,
          data: {
            dry_run: true,
            proposed: true,
            note:
              'DRY RUN — this action was recorded for replay evaluation only. Nothing was ' +
              'sent, saved, charged, or otherwise changed.',
            // PHASE 3B: runToolLoop's terminatesTurn handling reads
            // data.delivered_text as the turn's replyText for tools like
            // send_customer_reply — without this, a dry-run replay of a
            // terminal tool would silently produce an empty replyText,
            // making the replay harness unable to show what WOULD have
            // been sent. `body` is send_customer_reply's actual arg name;
            // this is a convention, not a guess specific to one tool name.
            ...(tool.terminatesTurn && args && typeof (args as Record<string, unknown>).body === 'string'
              ? { delivered_text: (args as Record<string, unknown>).body }
              : {}),
          },
        }
      },
    }
  })
}
