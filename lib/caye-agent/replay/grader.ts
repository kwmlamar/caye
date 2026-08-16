import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import type { ReplayReviewerJudgment, ReplayTurnResult } from './types'

/**
 * replay/grader.ts
 *
 * OPTIONAL, OFFLINE, ANALYSIS-ONLY. This is an "LLM-as-judge" helper that
 * drafts a `ReplayReviewerJudgment` for a human to check and correct — it
 * is NOT part of `runReplayTurn`/`runReplayBatch` (see harness.ts), is
 * never invoked automatically, and is never invoked by Caye's own
 * reasoning path in any runtime. Nothing here influences what Caye does;
 * it only proposes a label for a transcript that already finished
 * replaying, for whoever is running the evaluation to review.
 *
 * Distinguish this carefully from the classify-then-dispatch pattern the
 * architectural audit flags as the wrong direction (e.g.
 * `lib/whatsapp/intent.ts`): that pattern sits BEFORE a live turn and
 * decides how it gets handled. This sits AFTER a replayed turn has
 * already completed, has no bearing on any production behavior, and its
 * only consumer is a person deciding whether the candidate runtime is
 * ready — the same role a code reviewer plays reading a diff.
 *
 * Not wired into the automated test suite: grading calls the real
 * Anthropic API, which unit tests must not depend on (see
 * harness.test.ts, which exercises `runReplayTurn` with a stub runner and
 * never imports this file).
 */

const GRADER_SYSTEM = `You are grading a single replayed turn from an AI receptionist named Caye, for a human reviewer deciding whether a candidate runtime is ready. You did not generate the reply — you are reviewing it after the fact.

Given the situation Caye was shown and the reply/actions she produced, judge:
- intentType: was the human's message a question, a directive, a correction of something Caye already proposed, or a broader goal?
- scopeMatchedDirective: if intentType is 'directive', did Caye's reply do ONLY what was asked, or did it expand beyond the explicit ask?
- escalationWarranted / escalationOccurred: did the situation call for holding/escalating to a human, and did Caye's proposed actions do that?
- correctNoAction: if Caye produced no reply and proposed no actions, was that the right call given the situation?

Return your judgment via the grade_turn tool. Be honest about uncertainty — omit a field rather than guess.`

export async function gradeReplayTurn(
  client: Anthropic,
  model: string,
  situationSummary: string,
  result: ReplayTurnResult
): Promise<ReplayReviewerJudgment> {
  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system: GRADER_SYSTEM,
    tools: [
      {
        name: 'grade_turn',
        description: 'Record your grading judgment for this replayed turn.',
        input_schema: {
          type: 'object' as const,
          properties: {
            intent_type: { type: 'string', enum: ['question', 'directive', 'correction', 'goal'] },
            scope_matched_directive: { type: 'boolean' },
            escalation_warranted: { type: 'boolean' },
            escalation_occurred: { type: 'boolean' },
            correct_no_action: { type: 'boolean' },
            notes: { type: 'string', description: 'One or two sentences explaining the judgment.' },
          },
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'grade_turn' },
    messages: [
      {
        role: 'user',
        content:
          `SITUATION CAYE WAS SHOWN:\n${situationSummary}\n\n` +
          `CAYE'S REPLY:\n${result.replyText || '(no reply)'}\n\n` +
          `PROPOSED ACTIONS (dry-run, never executed):\n${
            result.proposedActions.length
              ? result.proposedActions.map((a) => `- ${a.toolName} (${a.risk}): ${JSON.stringify(a.args)}`).join('\n')
              : '(none)'
          }`,
      },
    ],
  })

  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  if (!block) return {}

  const input = block.input as {
    intent_type?: ReplayReviewerJudgment['intentType']
    scope_matched_directive?: boolean
    escalation_warranted?: boolean
    escalation_occurred?: boolean
    correct_no_action?: boolean
    notes?: string
  }

  return {
    intentType: input.intent_type,
    scopeMatchedDirective: input.scope_matched_directive,
    escalationWarranted: input.escalation_warranted,
    escalationOccurred: input.escalation_occurred,
    correctNoAction: input.correct_no_action,
    notes: input.notes,
  }
}
