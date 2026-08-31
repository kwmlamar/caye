import { describe, expect, it } from "vitest";
import { classifyStrategicEscalation } from "../escalation";
import { recommendationChangedMaterially, sanitizeStrategicHumanOutput } from "../presentation";
import { maybeEscalateRecommendation } from "../service";
import type { StrategicRecommendation } from "../types";

const evidence = (overrides = {}) => ({
  ref: "opaque-ref", claim: "Material capability improved", observedAt: new Date().toISOString(),
  sourceCount: 3, independentSourceCount: 2, confidence: 0.9, ...overrides,
});

const rec = (overrides: Partial<StrategicRecommendation> = {}): StrategicRecommendation => ({
  recommendation: "Run a reversible pilot",
  conciseReasoning: "Fresh independent evidence makes the opportunity actionable.",
  supportingEvidence: [evidence()], strongestCounterargument: "Adoption may lag capability.", confidence: 0.86,
  assumptions: ["Demand exists"], alternativesConsidered: ["Wait"], expectedUpside: "Meaningful learning and revenue",
  downsideRisk: "Limited pilot cost", reversibility: "easy", urgency: "immediate",
  whatWouldChangeCayesMind: ["Independent evidence reverses"], recommendedNextAction: "Authorize a bounded pilot",
  decisionAuthority: { principalType: "business", principalRef: "opaque", resolvedBy: "canonical_authority" },
  escalationLevel: 5, materialFingerprint: "v1", createdAt: new Date().toISOString(), ...overrides,
});

describe("strategic intelligence escalation", () => {
  it("does not spam on repeated unchanged recommendation", () => expect(recommendationChangedMaterially(rec(), rec())).toBe(false));
  it("changes recommendation when material evidence changes", () => expect(recommendationChangedMaterially(rec(), rec({ materialFingerprint: "v2" }))).toBe(true));
  it("keeps weak evidence below actionable", () => expect(classifyStrategicEscalation({ relevance: .9, materiality: .9, urgency: .9, evidence: [evidence({ confidence: .2, independentSourceCount: 0 })], actionable: true, crossDomainCorroboration: true })).toBe(1));
  it("keeps stale intelligence below actionable", () => expect(classifyStrategicEscalation({ relevance: .9, materiality: .9, urgency: .9, evidence: [evidence({ stale: true })], actionable: true, crossDomainCorroboration: true })).toBe(1));
  it("penalizes conflicting evidence", () => expect(classifyStrategicEscalation({ relevance: .9, materiality: .9, urgency: .9, evidence: [evidence({ contradicted: true })], actionable: true, crossDomainCorroboration: true })).toBeLessThan(5));
  it("prevents unsupported certainty from reaching level 5", () => expect(classifyStrategicEscalation({ relevance: .9, materiality: .9, urgency: .9, evidence: [evidence({ confidence: .55, independentSourceCount: 0 })], actionable: true, crossDomainCorroboration: true })).toBeLessThan(5));
  it("removes raw UUIDs and internal ids", () => expect(sanitizeStrategicHumanOutput("decision_id=abc 123e4567-e89b-42d3-a456-426614174000")).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i));

  it("does not interrupt when canonical authority cannot be resolved", async () => {
    let attention = 0;
    const deps = {
      resolveAuthority: async () => ({ principalType: "unknown" as const, principalRef: null, resolvedBy: "unresolved" as const }),
      enqueueCanonicalAttention: async () => { attention++; }, requestDeeperResearch: async () => {}, requestIndependentCrossCheck: async () => {},
    };
    expect(await maybeEscalateRecommendation(deps, rec(), null, "business", "workspace")).toBe(false);
    expect(attention).toBe(0);
  });
});
