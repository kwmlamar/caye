import 'server-only'

/**
 * Subscription-backed backends (Claude Code CLI, Codex CLI) authenticate
 * via a machine-bound local login (macOS Keychain / ~/.codex/auth.json —
 * see the multi-model router brief, section 13 and the implementation
 * report's answer to I). Vercel's serverless functions are stateless and
 * cold-started per request; there is no persistent filesystem or keychain
 * to hold that login, and no way to run an interactive OAuth browser flow
 * from inside one. Grafting credentials into env vars would only work
 * until the token needs interactive renewal, and would put a Claude/OpenAI
 * subscription credential in Vercel's environment where every serverless
 * invocation (not just Caye Direct) can reach it — exactly the founder-only
 * boundary this router exists to enforce. So: structurally, these backends
 * can only run where the CLI was actually logged in — Lamar's own machine.
 *
 * This function is the single place that decides "are we somewhere a
 * subscription CLI could plausibly be reachable." It is deliberately
 * conservative: default to "no" unless a bridge explicitly opts in.
 */
export function isLocalBridgeEnvironment(): boolean {
  if (process.env.VERCEL) return false
  return process.env.CAYE_DIRECT_LOCAL_BRIDGE === '1'
}
