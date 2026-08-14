/**
 * Builds the knowledge portion of a demo prompt. Kept separate from the
 * server-only demo runner so this boundary is regression-testable: a demo
 * must receive the same workspace facts that ground a real guest reply.
 */
export function withDemoBusinessFacts(systemPrompt: string, businessFactsBlock: string): string {
  const facts = businessFactsBlock.trim()
  return facts ? `${systemPrompt}\n\n${facts}` : systemPrompt
}
