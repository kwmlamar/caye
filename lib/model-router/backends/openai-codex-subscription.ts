import 'server-only'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BackendHealth, ModelBackend, ModelInvokeRequest, ModelInvokeResult } from '../types'
import type { ToolCapableBackend, ToolTurnRequest, ToolTurnResult } from '../tool-bridge/types'
import { renderToolManifest } from '../tool-bridge/render-tool-manifest'
import { renderTranscriptForCli } from '../tool-bridge/render-transcript'
import {
  extractCodexAgentMessageText,
  extractCodexFailureMessage,
  parseCodexStructuredToolResponse,
} from '../tool-bridge/parse-codex-tool-response'
import { isLocalBridgeEnvironment } from './local-bridge'
import { runSubprocess, SubprocessSpawnError, checkCliBinaryHealth } from './subprocess'
import { withIsolatedCwd } from './isolated-cwd'

/**
 * Runs the REAL Codex CLI binary (`codex`), authenticated via a ChatGPT
 * Plus/Pro/Team subscription login (`codex login`, or
 * `codex login --with-access-token` for headless/CI, per OpenAI's docs).
 * Same shape and reasoning as claude-subscription.ts: no OpenAI SDK, no
 * lifting the ChatGPT-derived credential into a raw API client.
 *
 * VALIDATED LIVE (2026-08-16) against the installed CLI (0.147.0 — the
 * global npm install was actually broken, missing its platform binary
 * package, until `npm install -g @openai/codex@latest` repaired it;
 * `codex login status` confirmed "Logged in using ChatGPT", i.e. real
 * subscription auth, not an API key):
 *   - `codex exec --json` writes JSONL events to STDOUT, not stderr.
 *   - the final answer is NOT a top-level field on the last line — it's
 *     nested at an `item.completed` event, `item.type === 'agent_message'`,
 *     `item.item.text`. An earlier version of this file assumed a
 *     top-level `.text`/`.content`/`.message` field and would have
 *     silently returned garbage; extractCodexAgentMessageText (in
 *     tool-bridge/parse-codex-tool-response.ts) is the fix, and is used
 *     for both the plain-text and tool-call paths below.
 *   - `--output-schema <file>` (OpenAI strict structured output) works
 *     cleanly for the tool-call protocol — see invokeTurn — and was
 *     preferred over Claude's prose-fenced-JSON approach specifically
 *     because it's provider-enforced, not prompt-compliance-dependent.
 *     Strict mode requires `additionalProperties: false` everywhere, which
 *     forbids an open `input` object for arbitrary tool arguments — hence
 *     `input_json` (a string) in codex-output-schema.json, parsed and then
 *     schema-validated by Caye same as the Claude path.
 *   - real quota exhaustion was hit live mid-testing: exit code 1, and a
 *     `turn.failed` event with `error.message`: "You've hit your usage
 *     limit. Upgrade to Pro ... or try again at Aug 20th, 2026 4:38 PM."
 *     That exact message is what error-classification.ts's quota pattern
 *     is tuned against.
 *   - Codex refuses to run outside a trusted git repo without
 *     `--skip-git-repo-check`, which is what surfaced the isolated-cwd
 *     design (isolated-cwd.ts) as the right fix rather than running from
 *     wherever this process happens to start.
 */
const CLI_TIMEOUT_MS = 55_000
const OUTPUT_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'tool-bridge', 'codex-output-schema.json')

export class OpenAICodexSubscriptionBackend implements ModelBackend, ToolCapableBackend {
  readonly id = 'openai_codex_subscription' as const
  readonly provider = 'openai' as const
  readonly authMode = 'subscription_cli' as const
  readonly capabilities = ['general_reasoning', 'coding', 'structured_output', 'local_repo_access'] as const

  async checkHealth(): Promise<BackendHealth> {
    return checkCliBinaryHealth('codex', minimalEnv())
  }

  async invoke(req: ModelInvokeRequest, signal: AbortSignal): Promise<ModelInvokeResult> {
    if (!isLocalBridgeEnvironment()) {
      throw new SubprocessSpawnError('openai_codex_subscription invoked outside the local bridge environment')
    }
    const prompt = composePrompt(req.system, renderTranscriptForCli(req.messages.map((m) => ({ role: m.role, content: m.text }))))
    const start = Date.now()

    const result = await withIsolatedCwd((cwd) =>
      runSubprocess({
        command: 'codex',
        args: baseArgs(cwd),
        stdin: prompt,
        env: minimalEnv(),
        cwd,
        timeoutMs: CLI_TIMEOUT_MS,
        signal,
      })
    )

    assertCleanExit(result)
    const text = extractCodexAgentMessageText(result.stdout) ?? result.stdout.trim()

    return {
      backend: 'openai_codex_subscription',
      text,
      latencyMs: Date.now() - start,
    }
  }

  /**
   * Tool-capable turn via native --output-schema (see file doc comment).
   * Parses the schema-conforming agent_message text into
   * {tool_calls|final_text}, then into Anthropic.ContentBlock[] — same
   * output currency as every other backend, so founder-tool-loop.ts never
   * branches on which provider answered.
   */
  async invokeTurn(req: ToolTurnRequest, signal: AbortSignal): Promise<ToolTurnResult> {
    if (!isLocalBridgeEnvironment()) {
      throw new SubprocessSpawnError('openai_codex_subscription invoked outside the local bridge environment')
    }
    const instructions = [
      req.system,
      '',
      'You have access to the following tools:',
      '',
      renderToolManifest(req.tools),
      '',
      'Decide whether to call a tool or give your final answer. Populate exactly one of `tool_calls` or `final_text` (leave the other null). `input_json` is the tool\'s input arguments, serialized as a JSON string.',
      '',
      // The schema constrains the OUTER shape (either tool_calls or
      // final_text, never malformed), but nothing stops the `final_text`
      // STRING value itself from containing invented tool-result-shaped
      // prose, so this still matters. Kept deliberately light — a heavier,
      // more insistent version of this same idea tested live against
      // claude-subscription.ts's protocol (2026-08-16) reproducibly pushed
      // that CLI into trying its own native tool-calling instead of
      // following the text protocol, hard-failing every call. Codex's
      // strict schema output makes that specific failure mode unlikely
      // here, but there's no live-verified evidence either way while
      // Codex remains quota-blocked, so this stays as light-touch defense
      // in depth rather than an imperative rule list, on the same
      // precautionary logic.
      'If giving a final answer, base it only on real results you have actually received, marked CAYE_RUNTIME_TOOL_RESULT — never write out what a tool result might look like, and never invent one.',
    ].join('\n')
    const prompt = composePrompt(instructions, renderTranscriptForCli(req.messages))
    const start = Date.now()

    const result = await withIsolatedCwd((cwd) =>
      runSubprocess({
        command: 'codex',
        args: [...baseArgs(cwd), '--output-schema', OUTPUT_SCHEMA_PATH],
        stdin: prompt,
        env: minimalEnv(),
        cwd,
        timeoutMs: CLI_TIMEOUT_MS,
        signal,
      })
    )

    assertCleanExit(result)

    const agentText = extractCodexAgentMessageText(result.stdout)
    const latencyMs = Date.now() - start
    if (agentText === null) {
      return { content: [{ type: 'text', text: result.stdout.trim(), citations: null }], latencyMs, toolCallsFromStructuredText: false }
    }

    const parsed = parseCodexStructuredToolResponse(agentText)
    if (parsed.kind === 'text') {
      return { content: [{ type: 'text', text: parsed.text, citations: null }], latencyMs, toolCallsFromStructuredText: false }
    }

    return {
      content: parsed.calls.map((call, i) => ({
        type: 'tool_use' as const,
        id: `codex_sub_${start}_${i}`,
        name: call.name,
        input: (call.input ?? {}) as Record<string, unknown>,
        caller: { type: 'direct' as const },
      })),
      latencyMs,
      toolCallsFromStructuredText: true,
    }
  }
}

function baseArgs(cwd: string): string[] {
  return [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--cd', cwd,
    '--ephemeral',
    '-',
  ]
}

/**
 * Codex has no --system-prompt-equivalent flag (checked: `codex exec
 * --help` has no such option). Both the instructions and the conversation
 * transcript go in the single prompt argument over stdin. Unlike the
 * earlier Claude Code SYSTEM:-label mistake, this was tested live and
 * raised no injection concern — the instructions are the FIRST thing in
 * the prompt, framed as instructions rather than a claimed role, and
 * Codex isn't tuned with the same "reject in-band role claims" reflex
 * Claude Code has. Kept simple (no role labels for the instructions block
 * itself) specifically to avoid re-triggering that class of problem.
 */
function composePrompt(instructions: string, transcript: string): string {
  return `${instructions}\n\n${transcript}`
}

/**
 * USER/LOGNAME included for the same reason as claude-subscription.ts's
 * minimalEnv: found live that macOS credential lookup for the Claude CLI
 * silently fails without them. Not separately confirmed as load-bearing
 * for Codex specifically, but cheap, low-risk, and consistent to include
 * rather than assume Codex's own auth lookup has no equivalent dependency.
 */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV }
  if (process.env.HOME) env.HOME = process.env.HOME
  if (process.env.USER) env.USER = process.env.USER
  if (process.env.LOGNAME) env.LOGNAME = process.env.LOGNAME
  return env
}

function assertCleanExit(result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }): void {
  if (result.timedOut) {
    throw Object.assign(new Error('codex CLI timed out'), { httpStatus: 500 })
  }
  if (result.exitCode !== 0) {
    const failureMessage = extractCodexFailureMessage(result.stdout) ?? result.stderr.slice(0, 500)
    const authExpired = /not logged in|token expired|please run .?codex login/i.test(failureMessage)
    const quotaExhausted = /usage limit|upgrade to (pro|plus)|purchase more credits/i.test(failureMessage)
    throw Object.assign(new Error(`codex CLI exited ${result.exitCode}: ${failureMessage}`), {
      exitCode: result.exitCode,
      authExpired,
      quotaExhausted,
    })
  }
}
