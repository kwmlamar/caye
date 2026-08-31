export type StrategicEscalationLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type StrategicAuthority = {
  principalType: "personal" | "workspace" | "business" | "unknown";
  principalRef: string | null;
  resolvedBy: "canonical_authority" | "unresolved";
};

export type StrategicEvidence = {
  ref: string;
  claim: string;
  observedAt: string;
  sourceCount: number;
  independentSourceCount: number;
  confidence: number;
  stale?: boolean;
  contradicted?: boolean;
};

export type StrategicRecommendation = {
  recommendation: string;
  conciseReasoning: string;
  supportingEvidence: StrategicEvidence[];
  strongestCounterargument: string;
  confidence: number;
  assumptions: string[];
  alternativesConsidered: string[];
  expectedUpside: string;
  downsideRisk: string;
  reversibility: "easy" | "moderate" | "hard" | "irreversible";
  urgency: "low" | "medium" | "high" | "immediate";
  whatWouldChangeCayesMind: string[];
  recommendedNextAction: string;
  decisionAuthority: StrategicAuthority;
  escalationLevel: StrategicEscalationLevel;
  materialFingerprint: string;
  createdAt: string;
};

export type WeeklyStrategicBrief = {
  whatChanged: string[];
  whatINowBelieve: string[];
  whatYouShouldKnow: string[];
  whatYouMightBeMissing: string[];
  strongestOpportunities: StrategicRecommendation[];
  threatsAndChangedAssumptions: string[];
  whatShouldHappenNext: StrategicRecommendation[];
  stillInvestigating: string[];
};
