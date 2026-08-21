import 'server-only'
import type { Tool } from '@/lib/caye-agent/tools/types'

/**
 * Renders the real registry tools' name/description/inputSchema into a
 * plain-text block for a CLI backend's prompt. Formatting only — never
 * touches what a tool does or which arguments it requires; that's still
 * tool.inputSchema, read from the same TOOL_REGISTRY entries runToolLoop
 * uses, and validated again on the way back in (schema-validate.ts).
 */
export function renderToolManifest(tools: readonly Tool<never>[]): string {
  if (tools.length === 0) return 'No tools are available for this turn.'
  return tools
    .map((t) => `- ${t.name}: ${t.description}\n  input_schema: ${JSON.stringify(t.inputSchema)}`)
    .join('\n')
}
