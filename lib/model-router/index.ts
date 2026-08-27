import 'server-only'

/**
 * Public surface of the Caye Direct model router. Nothing here is wired
 * into a route yet — see docs/agents/model-router.md and the
 * implementation report for what's deferred and why.
 */
export * from './types'
export * from './founder-gate'
export * from './capabilities'
export * from './router'
export * from './error-classification'
export * from './observability'
export { isLocalBridgeEnvironment } from './backends/local-bridge'
export { AnthropicApiBackend } from './backends/anthropic-api'
export { ClaudeSubscriptionBackend } from './backends/claude-subscription'
export { OpenAICodexSubscriptionBackend } from './backends/openai-codex-subscription'
export { OpenAIApiBackend, OpenRouterBackend } from './backends/openai-compatible'

// Tool bridge — Option B founder-only orchestration loop. Reuses Caye's
// existing TOOL_REGISTRY/orchestrator/action-claim-guard unchanged; see
// tool-bridge/founder-tool-loop.ts's doc comment for the full architecture
// rationale. NOT wired into any Caye Direct route yet.
export * from './tool-bridge/types'
export * from './tool-bridge/parsed-turn-response'
export { validateAgainstSchema } from './tool-bridge/schema-validate'
export { renderToolManifest } from './tool-bridge/render-tool-manifest'
export { renderTranscriptForCli } from './tool-bridge/render-transcript'
export { runToolTurnWithFallback } from './tool-bridge/tool-turn-router'
export {
  runFounderToolLoop,
  ProtocolViolationError,
  type FounderToolLoopArgs,
  type FounderToolLoopResult,
} from './tool-bridge/founder-tool-loop'
export { detectProtocolArtifacts, type ProtocolArtifactFinding } from './tool-bridge/protocol-artifact-guard'
export { requiresBusinessGrounding } from './tool-bridge/business-grounding-classifier'
