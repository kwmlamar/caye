import 'server-only'

/**
 * Deterministic operator controls.
 *
 * Some operator messages are *controls*, not conversation: they name an
 * unambiguous state change Caye can resolve from its own data. Routing those
 * through the tool loop makes basic operator control depend on a free-form
 * model call, and on 2026-09-01 that is exactly what broke — Anthropic's
 * balance was exhausted, the founder's 129-tool surface exceeded OpenAI's
 * 128-tool cap, and `Switch to ods` came back as "Sorry, I hit a snag with
 * that" three times for a workspace the founder demonstrably had access to.
 *
 * The gateway defect that caused that is fixed separately (lib/ai). This
 * exists because a control that CAN be resolved deterministically should not
 * be one provider outage away from failing at all.
 *
 * Scope is deliberately narrow:
 *   - only the switch-workspace control;
 *   - only an unambiguous, already-authorized target;
 *   - anything else falls through to the agent, which can ask a better
 *     question than a regex can.
 *
 * Authorization is NOT reimplemented here. The caller runs the existing
 * `switch_workspace` tool, so the allowlist/verification gate stays in one
 * place and this path cannot become a way around it.
 */

/**
 * Longest plausible business name. Anything longer is prose ("switch to a
 * more formal tone for the rest of the day"), not a workspace name, and
 * belongs to the agent.
 */
const MAX_TARGET_LENGTH = 60

const SWITCH_PATTERN =
  /^\s*(?:switch|change|move|jump|take me|go)\s+(?:me\s+)?(?:back\s+)?(?:to|over\s+to|into)\s+(.+?)\s*$/i

/** Trailing chatter that is punctuation, not part of the name. */
const TRAILING_NOISE = /[\s.!?,;:]+$/
/** Filler the founder may add around the name: "the ods workspace", "ods please". */
const LEADING_ARTICLE = /^(?:the|my)\s+/i
const TRAILING_NOUN = /\s+(?:workspace|account|business|please|now|thanks)$/i

/**
 * Extract the workspace name from a switch command, or null when this is not
 * unambiguously a workspace switch.
 *
 * Conservative by construction: a false negative costs one model call, while
 * a false positive hijacks a message the founder meant as conversation.
 */
export function parseWorkspaceSwitchCommand(text: string): string | null {
  if (!text || text.includes('\n')) return null

  const match = SWITCH_PATTERN.exec(text)
  if (!match) return null

  let target = match[1].replace(TRAILING_NOISE, '')
  // Strip filler repeatedly so "the ods workspace please" reduces to "ods".
  for (let i = 0; i < 3; i += 1) {
    const before = target
    target = target.replace(LEADING_ARTICLE, '').replace(TRAILING_NOUN, '').replace(TRAILING_NOISE, '')
    if (target === before) break
  }

  if (target.length < 2 || target.length > MAX_TARGET_LENGTH) return null
  // A name, not a clause. Multi-word names are fine ("bimini island tours"),
  // but anything this long is prose.
  if (target.split(/\s+/).length > 5) return null

  return target
}

export interface WorkspaceSwitchOutcome {
  reply: string
  outcome: 'switched' | 'ambiguous' | 'unauthorized'
}

/**
 * Resolve a parsed switch target by running the existing `switch_workspace`
 * tool directly — same allowlist + verified-founder gate the model-driven
 * path uses, so this cannot become a bypass.
 *
 * Returns null when the answer is genuinely conversational (no workspace
 * matched, or the tool failed for an unexpected reason). Those fall through
 * to the agent rather than being answered by a regex: "switch to something
 * less formal" should not be met with "No workspace found matching that."
 */
export async function resolveWorkspaceSwitch(
  target: string,
  currentWorkspaceId: string,
  callerRole: string,
  operatorId?: number | null
): Promise<WorkspaceSwitchOutcome | null> {
  if (callerRole !== 'founder') return null

  const { switchWorkspace } = await import('@/lib/caye-agent/tools/write-low/switch-workspace')

  let result
  try {
    result = await switchWorkspace.execute(
      { workspace: target },
      { workspaceId: currentWorkspaceId, callerRole: 'founder', operatorId } as never
    )
  } catch (error) {
    console.error('[operator-controls] switch_workspace threw; deferring to agent', error)
    return null
  }

  if (result.ok) {
    const name = (result.data as { switched_to?: string } | undefined)?.switched_to ?? target
    return { reply: `Done — you're on ${name} now.`, outcome: 'switched' }
  }

  const error = result.error ?? ''
  // Definitive, data-backed answers. Saying these without a model call is
  // strictly better than failing, and strictly better than guessing.
  if (/multiple workspaces match/i.test(error)) {
    return { reply: error, outcome: 'ambiguous' }
  }
  if (/don't have founder access/i.test(error)) {
    return { reply: error, outcome: 'unauthorized' }
  }
  return null
}
