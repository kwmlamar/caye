import 'server-only'
import type { BackendId, Capability } from './types'

/**
 * Static capability table. Deliberately honest about what each backend
 * cannot do rather than pretending parity — see the multi-model router
 * brief, section 5.
 *
 * claude_subscription / openai_codex_subscription: real CLI agents with
 * their OWN tool-use/session machinery, but here they are invoked
 * text-in/text-out only (system + rendered transcript -> reply text).
 * Caye's TOOL_REGISTRY is not bridged through them yet (see backends/*
 * for why), so `tool_use` is NOT claimed for either even though the
 * underlying CLIs support tool use in their native harness.
 */
export const BACKEND_CAPABILITIES: Record<BackendId, readonly Capability[]> = {
  claude_subscription: [
    'general_reasoning',
    'coding',
    'long_context',
    'structured_output',
    'local_repo_access',
  ],
  openai_codex_subscription: [
    'general_reasoning',
    'coding',
    'structured_output',
    'local_repo_access',
  ],
  anthropic_api: [
    'general_reasoning',
    'coding',
    'tool_use',
    'long_context',
    'vision',
    'structured_output',
    'persisted_session',
  ],
  openai_api: [
    'general_reasoning',
    'coding',
    'tool_use',
    'structured_output',
    'vision',
  ],
}

export function backendSupports(backend: BackendId, capability: Capability): boolean {
  return BACKEND_CAPABILITIES[backend].includes(capability)
}

export function requiredCapabilitiesFor(hints: {
  isCodingOrRepoTask?: boolean
  needsLongContext?: boolean
  needsVision?: boolean
  needsToolUse?: boolean
  needsSessionContinuity?: boolean
} | undefined): Capability[] {
  const required: Capability[] = ['general_reasoning']
  if (!hints) return required
  if (hints.isCodingOrRepoTask) required.push('coding')
  if (hints.needsLongContext) required.push('long_context')
  if (hints.needsVision) required.push('vision')
  if (hints.needsToolUse) required.push('tool_use')
  if (hints.needsSessionContinuity) required.push('persisted_session')
  return required
}
