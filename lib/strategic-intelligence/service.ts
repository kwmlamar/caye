import { classifyStrategicEscalation, shouldInterrupt, type EscalationInput } from "./escalation";
import { recommendationChangedMaterially, sanitizeStrategicHumanOutput } from "./presentation";
import type { StrategicAuthority, StrategicRecommendation } from "./types";

export type StrategicDependencies = {
  resolveAuthority(input: { scope: "personal" | "business"; workspaceRef?: string }): Promise<StrategicAuthority>;
  enqueueCanonicalAttention(input: {
    authority: StrategicAuthority;
    kind: "strategic_intelligence";
    urgency: "immediate";
    title: string;
    body: string;
    dedupeKey: string;
  }): Promise<void>;
  requestDeeperResearch(input: EscalationInput): Promise<void>;
  requestIndependentCrossCheck(input: EscalationInput): Promise<void>;
};

export async function routeStrategicSignal(deps: StrategicDependencies, input: EscalationInput): Promise<number> {
  const level = classifyStrategicEscalation(input);
  if (level === 2) await deps.requestDeeperResearch(input);
  if (level >= 3) await deps.requestIndependentCrossCheck(input);
  return level;
}

export async function maybeEscalateRecommendation(
  deps: StrategicDependencies,
  recommendation: StrategicRecommendation,
  previous: StrategicRecommendation | null,
  scope: "personal" | "business",
  workspaceRef?: string,
): Promise<boolean> {
  if (!shouldInterrupt(recommendation.escalationLevel)) return false;
  if (!recommendationChangedMaterially(previous, recommendation)) return false;

  const authority = await deps.resolveAuthority({ scope, workspaceRef });
  if (authority.resolvedBy !== "canonical_authority" || !authority.principalRef) return false;

  await deps.enqueueCanonicalAttention({
    authority,
    kind: "strategic_intelligence",
    urgency: "immediate",
    title: sanitizeStrategicHumanOutput(recommendation.recommendation),
    body: sanitizeStrategicHumanOutput(`${recommendation.conciseReasoning}\nNext: ${recommendation.recommendedNextAction}`),
    dedupeKey: `strategic:${recommendation.materialFingerprint}`,
  });
  return true;
}

export const CAYE_DIRECT_STRATEGIC_INTENTS = [
  "what changed this week",
  "what are you currently researching",
  "what do you think i'm missing",
  "what are your strongest beliefs right now",
  "what changed your mind recently",
  "what opportunities do you think i'm overlooking",
  "what should i do next and why",
  "what evidence would change your recommendation",
] as const;
