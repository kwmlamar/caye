import 'server-only'

// Per-million-token prices in USD. Update as Anthropic pricing changes.
// Shared by app/api/admin/llm-spend and app/api/founder/command-overview
// so the two "what is this costing" surfaces never drift apart.
export const LLM_PRICING: Record<
  string,
  { input: number; output: number; cache_read: number; cache_write_1h: number }
> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_write_1h: 6 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cache_read: 0.1, cache_write_1h: 2 },
}

export function costForModel(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number
): number {
  const p = LLM_PRICING[model]
  if (!p) return 0
  return (
    (input * p.input) / 1_000_000 +
    (output * p.output) / 1_000_000 +
    (cacheRead * p.cache_read) / 1_000_000 +
    (cacheWrite * p.cache_write_1h) / 1_000_000
  )
}
