import 'server-only'

/**
 * Deterministic guard against a subscription backend narrating/simulating
 * the tool protocol instead of participating in it — found live,
 * reproducibly, 2026-08-16 (see fixtures/fabricated-tool-transcripts.ts):
 * asked a question needing a second read, Claude twice wrote a single text
 * response containing an invented tool_calls block, an invented "TOOL
 * RESULT," a second invented call, a second invented result, and a
 * confident final answer built on none of it — with completely different
 * fabricated data each time. Zero real tools ran either time; the danger
 * is not execution (that boundary held), it's that the fabricated text
 * looked exactly like a normal grounded answer.
 *
 * NOT a general truthfulness checker. It does not decide whether business
 * facts are true — that's out of scope, same restraint
 * action-claim-guard.ts already applies to completion claims. It only
 * asks: does this text contain the SHAPE of the tool protocol itself
 * (fenced tool_calls JSON, TOOL RESULT-style narration, Caye's own
 * result-provenance marker) appearing somewhere it shouldn't — i.e. inside
 * text Caye is about to treat as an ordinary final answer, not as a
 * genuine structured request handled by the normal parser.
 *
 * Deliberately narrow: matches specific protocol tokens
 * (tool_calls/tool_use/tool_result/"TOOL RESULT"/the CAYE_RUNTIME_TOOL_*
 * markers this module's callers use for genuine results), not the bare
 * word "tool" — ordinary prose discussing "the right tool for this job"
 * must never trip it. See protocol-artifact-guard.test.ts's innocent-prose
 * cases.
 */
export interface ProtocolArtifactFinding {
  violated: boolean
  reasons: string[]
}

const PROTOCOL_TOKEN_PATTERNS: readonly RegExp[] = [
  /\btool_calls\b/i,
  /\btool_use\b/i,
  /\btool_result\b/i,
  /\bTOOL RESULT\b/i,
  /\bCAYE_RUNTIME_TOOL_RESULT\b/i,
  /\bCAYE_RUNTIME_TOOL_REQUEST\b/i,
]

/** Fenced ```/```json blocks, non-greedy, global. */
const FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/g

/**
 * Structural check first: does any fenced block in this text parse as JSON
 * carrying a `tool_calls` key? Runs regardless of what's around the fence
 * — by the time this guard is invoked, the caller has already established
 * this text is NOT the strict single-fence-only shape a real tool request
 * takes (that's handled and executed earlier, before this guard ever
 * runs), so ANY tool_calls-shaped JSON found here is, by construction,
 * mixed into other content and therefore simulated narration, not a real
 * request.
 */
function findFencedToolCallArtifacts(text: string): string[] {
  const reasons: string[] = []
  for (const match of text.matchAll(FENCE_PATTERN)) {
    const inner = match[1]
    try {
      const parsed: unknown = JSON.parse(inner)
      if (parsed && typeof parsed === 'object' && 'tool_calls' in (parsed as Record<string, unknown>)) {
        reasons.push('contains a fenced block matching the tool-call protocol shape ({"tool_calls":...}), mixed with other content')
      }
    } catch {
      // Not JSON — not a structural finding on its own; token scan below still applies.
    }
  }
  return reasons
}

function findProtocolTokenArtifacts(text: string): string[] {
  const reasons: string[] = []
  for (const pattern of PROTOCOL_TOKEN_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(`contains protocol-artifact token matching ${pattern}`)
    }
  }
  return reasons
}

export function detectProtocolArtifacts(text: string): ProtocolArtifactFinding {
  const reasons = [...new Set([...findFencedToolCallArtifacts(text), ...findProtocolTokenArtifacts(text)])]
  return { violated: reasons.length > 0, reasons }
}
