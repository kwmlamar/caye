import 'server-only'
import type { BackendHealth, ModelBackend, ModelInvokeRequest, ModelInvokeResult } from '../types'
import type { ToolCapableBackend, ToolTurnRequest, ToolTurnResult } from '../tool-bridge/types'
import { renderToolManifest } from '../tool-bridge/render-tool-manifest'
import { renderTranscriptForCli } from '../tool-bridge/render-transcript'
import { parseClaudeFencedToolResponse } from '../tool-bridge/parse-claude-tool-response'
import { isLocalBridgeEnvironment } from './local-bridge'
import { runSubprocess, SubprocessSpawnError, checkCliBinaryHealth } from './subprocess'
import { withIsolatedCwd } from './isolated-cwd'

/**
 * Runs the REAL Claude Code CLI binary (`claude`), authenticated via a
 * Claude Pro/Max/Team/Enterprise subscription login (`claude setup-token`
 * -> CLAUDE_CODE_OAUTH_TOKEN, or an interactive `/login` session already on
 * this machine). This is deliberately NOT the Agent SDK and NOT the raw
 * `@anthropic-ai/sdk` Messages API with the OAuth token grafted in as an
 * API key — Anthropic's usage policy (clarified Feb 2026, server-side
 * enforced since Jan 2026) explicitly bans subscription OAuth credentials
 * in "any other product, tool, or service ... including the Agent SDK."
 * Shelling out to the actual `claude` binary in headless print mode IS
 * Claude Code, so it stays on the supported side of that line.
 *
 * VALIDATED LIVE (2026-08-16) against the installed CLI (2.1.185,
 * subscription-authenticated — no ANTHROPIC_API_KEY in env, so auth fell
 * through to the /login credential per the documented precedence order):
 *   - plain reasoning: `claude -p ... --allowedTools "" --permission-mode
 *     dontAsk` returns `{"result": "..."}` in --output-format json — matches
 *     extractText() below.
 *   - the tool-call protocol (see invokeTurn): works cleanly with
 *     --system-prompt carrying the real instructions.
 *   - an EARLIER version of this backend rendered the system prompt as
 *     in-band "SYSTEM:\n...\nUSER:\n..." text piped over stdin. Claude Code
 *     correctly flagged it as a PROMPT INJECTION ATTEMPT and refused —
 *     role labels inside user/stdin content aren't trustworthy, and it
 *     shouldn't treat them as one. Fixed by using the real --system-prompt
 *     flag; re-tested clean.
 *   - Claude Code's own --json-schema flag was also tried (for parity with
 *     Codex's --output-schema) and deadlocked against --allowedTools ""
 *     + --max-turns 1 (error_max_turns, stop_reason: tool_use, null
 *     result) — it appears to route structured output through an internal
 *     tool-call mechanism that needs a grant this backend deliberately
 *     doesn't give it. Not worth loosening --allowedTools to work around;
 *     the prose-fenced-JSON protocol (parse-claude-tool-response.ts),
 *     already proven reliable, is used instead.
 */
const CLI_TIMEOUT_MS = 55_000
const MAX_BUDGET_USD = '1.00'

export class ClaudeSubscriptionBackend implements ModelBackend, ToolCapableBackend {
  readonly id = 'claude_subscription' as const
  readonly provider = 'anthropic' as const
  readonly authMode = 'subscription_cli' as const
  readonly capabilities = ['general_reasoning', 'coding', 'long_context', 'structured_output', 'local_repo_access'] as const

  async checkHealth(): Promise<BackendHealth> {
    return checkCliBinaryHealth('claude', minimalEnv())
  }

  async invoke(req: ModelInvokeRequest, signal: AbortSignal): Promise<ModelInvokeResult> {
    if (!isLocalBridgeEnvironment()) {
      throw new SubprocessSpawnError('claude_subscription invoked outside the local bridge environment')
    }
    const prompt = renderTranscriptForCli(req.messages.map((m) => ({ role: m.role, content: m.text })))
    const start = Date.now()

    const result = await withIsolatedCwd((cwd) =>
      runSubprocess({
        command: 'claude',
        args: baseArgs(req.system),
        stdin: prompt,
        env: minimalEnv(),
        cwd,
        timeoutMs: CLI_TIMEOUT_MS,
        signal,
      })
    )

    assertCleanExit(result)

    return {
      backend: 'claude_subscription',
      text: extractPlainText(result.stdout),
      latencyMs: Date.now() - start,
    }
  }

  /**
   * Tool-capable turn. Renders the real (mode-filtered) TOOL_REGISTRY
   * entries into the system prompt as a manifest, plus strict
   * fenced-JSON-response instructions, and parses the CLI's response back
   * into Anthropic.ContentBlock[] — real tool_use blocks with a synthetic
   * id (the CLI has no native id concept in this protocol) or a plain text
   * block. Caye's founder-tool-loop treats this identically to a native
   * Anthropic tool_use response; it does not know or care that this
   * backend derived it from parsed text.
   */
  async invokeTurn(req: ToolTurnRequest, signal: AbortSignal): Promise<ToolTurnResult> {
    if (!isLocalBridgeEnvironment()) {
      throw new SubprocessSpawnError('claude_subscription invoked outside the local bridge environment')
    }
    const system = `${req.system}\n\n${renderToolCallProtocol(req.tools)}`
    const prompt = renderTranscriptForCli(req.messages)
    const start = Date.now()

    const result = await withIsolatedCwd((cwd) =>
      runSubprocess({
        command: 'claude',
        args: baseArgs(system),
        stdin: prompt,
        env: minimalEnv(),
        cwd,
        timeoutMs: CLI_TIMEOUT_MS,
        signal,
      })
    )

    assertCleanExit(result)

    const rawText = extractPlainText(result.stdout)
    const parsed = parseClaudeFencedToolResponse(rawText)
    const latencyMs = Date.now() - start

    if (parsed.kind === 'text') {
      return {
        content: [{ type: 'text', text: parsed.text, citations: null }],
        latencyMs,
        toolCallsFromStructuredText: false,
      }
    }

    return {
      content: parsed.calls.map((call, i) => ({
        type: 'tool_use' as const,
        id: `claude_sub_${start}_${i}`,
        name: call.name,
        input: (call.input ?? {}) as Record<string, unknown>,
        caller: { type: 'direct' as const },
      })),
      latencyMs,
      toolCallsFromStructuredText: true,
    }
  }
}

function baseArgs(systemPrompt: string): string[] {
  return [
    '-p',
    '--system-prompt', systemPrompt,
    '--output-format', 'json',
    '--max-turns', '1',
    '--allowedTools', '',
    '--permission-mode', 'dontAsk',
    '--max-budget-usd', MAX_BUDGET_USD,
  ]
}

/**
 * Hardened 2026-08-16 after a real, reproducible failure: asked a question
 * needing a second read, Claude twice wrote a single text response
 * narrating an entire fabricated tool_calls/TOOL RESULT exchange instead
 * of making a real second request (see
 * fixtures/fabricated-tool-transcripts.ts). This is defense IN ADDITION
 * to the deterministic protocol-artifact-guard.ts check Caye runs on the
 * output — tightening the prompt reduces how often the guard has to catch
 * anything, it doesn't replace the guard.
 *
 * A first hardening attempt (heavy "Every response is EXACTLY ONE of..."
 * / "TOOL REQUEST" / "Hard rules, no exceptions" framing) was tested live
 * and made things WORSE, not better: it reproducibly pushed Claude Code's
 * own underlying agent into trying to use its NATIVE tool-calling
 * mechanism (stop_reason: 'tool_use' in the CLI's own JSON envelope) —
 * blocked by --allowedTools "", so it just burned through --max-turns
 * retrying instead of ever answering. Confirmed by bisection: the
 * ORIGINAL lighter wording plus one added sentence about not fabricating
 * results works cleanly (both the tool-request and final-answer paths,
 * including a real round-2 request driven by a real CAYE_RUNTIME_TOOL_RESULT).
 * Lesson kept here on purpose — do not re-add heavy imperative "tool
 * request" framing to this prompt without re-testing live against the
 * real CLI first.
 */
function renderToolCallProtocol(tools: ToolTurnRequest['tools']): string {
  return [
    'You have access to the following tools:',
    '',
    renderToolManifest(tools),
    '',
    'To call a tool, respond with ONLY a single fenced code block in this exact JSON shape, and nothing else — no other text before or after it:',
    '```json',
    '{"tool_calls":[{"name":"<tool_name>","input":{...}}]}',
    '```',
    'You may include multiple entries in tool_calls to call more than one tool this round.',
    '',
    'If you are not calling a tool and are giving your final answer instead, respond with plain text only — do not use a code fence and do not emit JSON. Base your answer only on real results you have actually received in this conversation, marked CAYE_RUNTIME_TOOL_RESULT — never write out what a tool result might look like, and never invent one.',
  ].join('\n')
}

function assertCleanExit(result: { exitCode: number | null; stderr: string; timedOut: boolean }): void {
  if (result.timedOut) {
    throw Object.assign(new Error('claude CLI timed out'), { httpStatus: 500 })
  }
  if (result.exitCode !== 0) {
    const authExpired = /login expired|please run \/login|not authenticated/i.test(result.stderr)
    throw Object.assign(new Error(`claude CLI exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`), {
      exitCode: result.exitCode,
      authExpired,
    })
  }
}

/**
 * No product ANTHROPIC_API_KEY, no Supabase keys, no WhatsApp tokens —
 * mirrors the isolation stance already established for the /code sandbox
 * (lib/coding-session/boot.ts). The CLI resolves its own subscription
 * login from local credential storage; it needs nothing from Caye's env.
 */
/**
 * USER/LOGNAME are load-bearing, not cosmetic — found live (2026-08-16):
 * without them, macOS Keychain credential lookup silently fails and the
 * CLI reports "Not logged in · Please run /login" even with a real,
 * working subscription session. Reproduced and fixed by bisecting a
 * minimal env down from a working full-env invocation.
 */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV }
  if (process.env.HOME) env.HOME = process.env.HOME
  if (process.env.USER) env.USER = process.env.USER
  if (process.env.LOGNAME) env.LOGNAME = process.env.LOGNAME
  if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
  return env
}

/**
 * `claude -p --output-format json` field names verified live (2026-08-16,
 * CLI 2.1.185) — the answer is at top-level `.result`. `.text`/`.content`
 * kept as defensive fallbacks in case a future CLI version renames the
 * field; raw stdout is the last resort rather than an error, since a
 * malformed parse here should degrade to "treat it as the answer," not
 * crash the loop.
 */
function extractPlainText(stdout: string): string {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.result === 'string') return obj.result
      if (typeof obj.text === 'string') return obj.text
      if (typeof obj.content === 'string') return obj.content
    }
  } catch {
    // fall through to raw stdout
  }
  return stdout.trim()
}
