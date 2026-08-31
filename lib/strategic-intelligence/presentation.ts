import type { StrategicRecommendation, WeeklyStrategicBrief } from "./types";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const INTERNAL_ID = /\b(?:workspace|user|principal|attention|decision|claim|evidence|research_run)_id\s*[:=]\s*\S+/gi;

export function sanitizeStrategicHumanOutput(value: string): string {
  return value.replace(UUID, "[internal reference]").replace(INTERNAL_ID, "[internal reference]");
}

export function recommendationChangedMaterially(
  previous: StrategicRecommendation | null,
  next: StrategicRecommendation,
): boolean {
  if (!previous) return true;
  return previous.materialFingerprint !== next.materialFingerprint;
}

export function renderRecommendation(r: StrategicRecommendation): string {
  const evidence = r.supportingEvidence.slice(0, 4).map((e) => `- ${e.claim}`).join("\n");
  return sanitizeStrategicHumanOutput([
    r.recommendation,
    `Why: ${r.conciseReasoning}`,
    `Confidence: ${Math.round(r.confidence * 100)}%`,
    `Evidence:\n${evidence || "- Evidence is still developing."}`,
    `Strongest counterargument: ${r.strongestCounterargument}`,
    `Upside: ${r.expectedUpside}`,
    `Risk: ${r.downsideRisk}`,
    `Reversibility: ${r.reversibility}`,
    `Urgency: ${r.urgency}`,
    `Next action: ${r.recommendedNextAction}`,
    `What would change my mind: ${r.whatWouldChangeCayesMind.join("; ")}`,
  ].join("\n"));
}

export function renderWeeklyBrief(brief: WeeklyStrategicBrief): string {
  const section = (title: string, items: string[]) => `${title}\n${items.length ? items.map((x) => `- ${x}`).join("\n") : "- Nothing material this week."}`;
  return sanitizeStrategicHumanOutput([
    section("WHAT CHANGED?", brief.whatChanged),
    section("WHAT DO I NOW BELIEVE?", brief.whatINowBelieve),
    section("WHAT SHOULD YOU KNOW?", brief.whatYouShouldKnow),
    section("WHAT MIGHT YOU BE MISSING?", brief.whatYouMightBeMissing),
    section("WHAT OPPORTUNITIES LOOK STRONGEST?", brief.strongestOpportunities.map((r) => `${r.recommendation} (${Math.round(r.confidence * 100)}%)`)),
    section("WHAT THREATS/ASSUMPTIONS CHANGED?", brief.threatsAndChangedAssumptions),
    section("WHAT SHOULD HAPPEN NEXT?", brief.whatShouldHappenNext.map((r) => r.recommendedNextAction)),
    section("WHAT AM I STILL INVESTIGATING?", brief.stillInvestigating),
  ].join("\n\n"));
}
