import { createHash } from "node:crypto";

export const CAREER_OPPORTUNITY_DESK_ID = "career-economic-opportunity" as const;

export const CAREER_OPPORTUNITY_CATEGORIES = [
  "full_time_role",
  "contract_work",
  "it_field_work",
  "software_ai_role",
  "startup_opportunity",
  "consulting",
  "grant",
  "fellowship",
  "accelerator",
  "government_program",
  "remote_opportunity",
  "partnership",
  "emerging_occupation",
  "high_demand_skill",
  "labor_shortage_industry",
  "geographic_opportunity",
  "entrepreneurship",
  "acquisition",
  "project_based_work",
] as const;

export type CareerOpportunityCategory =
  (typeof CAREER_OPPORTUNITY_CATEGORIES)[number];

export const CAREER_OPPORTUNITY_STANDING_QUESTIONS = [
  "What are the highest-upside realistic ways for this user to earn money now?",
  "Which opportunities are unusually under-discovered?",
  "Which emerging skills are rapidly increasing in economic value?",
  "Which industries are suddenly hiring because of technological change?",
  "Which paths maximize income while preserving time and optionality?",
  "What opportunities exist that the user probably would not think to search for?",
  "Has new information changed the ranking of previously identified paths?",
] as const;

export type OpportunityConstraint = {
  kind:
    | "work_authorization"
    | "location"
    | "time"
    | "capital"
    | "credential"
    | "experience"
    | "other";
  description: string;
  authoritativeVerificationRequired?: boolean;
};

export type OpportunityEvidence = {
  sourceUrl?: string;
  sourceTitle?: string;
  claim: string;
  observedAt: string;
  confidence?: number;
};

export type OpportunityScores = {
  expectedIncome: number;
  probabilityOfObtaining: number;
  timeToIncome: number;
  opportunityCost: number;
  skillAccumulation: number;
  networkValue: number;
  geographicFlexibility: number;
  independentProjectTime: number;
  downside: number;
  reversibility: number;
  longTermOptionality: number;
};

export type CareerOpportunity = {
  id?: string;
  fingerprint?: string;
  category: CareerOpportunityCategory;
  title: string;
  organization?: string;
  location?: string;
  description: string;
  evidence: OpportunityEvidence[];
  whyNow: string;
  estimatedUpside: string;
  requirements: string[];
  constraints: OpportunityConstraint[];
  uncertainty: string[];
  deadline?: string | null;
  expiresAt?: string | null;
  nextInformationNeeded: string[];
  recommendedNextStep: string;
  scores: OpportunityScores;
  discoveredAt: string;
  updatedAt: string;
  status?: "active" | "expired" | "dismissed" | "pursuing";
  rank?: number;
  previousRank?: number;
  rankDelta?: number;
};

export type CareerOpportunityDeskDefinition = {
  id: typeof CAREER_OPPORTUNITY_DESK_ID;
  domain: "career_economic_opportunity";
  standingMission: string;
  standingQuestions: readonly string[];
  categories: readonly CareerOpportunityCategory[];
  defaultCadence: { intervalHours: number };
  explorationBudget: {
    minimumNonJobCategoriesPerRun: number;
    minimumUnderDiscoveredQueriesPerRun: number;
  };
  outputKind: "opportunity";
  contextPolicy: {
    acceptsUserContext: true;
    acceptsWorkspaceContext: true;
    hardCodeBiography: false;
  };
  legalPolicy: {
    makeLegalDeterminations: false;
    workAuthorizationRequiresAuthoritativeVerification: true;
  };
};

export const careerOpportunityDesk: CareerOpportunityDeskDefinition = {
  id: CAREER_OPPORTUNITY_DESK_ID,
  domain: "career_economic_opportunity",
  standingMission:
    "Continuously identify unusually strong, evidence-backed ways for the user to increase income, career leverage, skills, network, geographic flexibility, and long-term optionality. The best opportunity may be a role, contract, field assignment, business, grant, fellowship, partnership, acquisition, or another path that is not a traditional software job.",
  standingQuestions: CAREER_OPPORTUNITY_STANDING_QUESTIONS,
  categories: CAREER_OPPORTUNITY_CATEGORIES,
  defaultCadence: { intervalHours: 12 },
  explorationBudget: {
    minimumNonJobCategoriesPerRun: 4,
    minimumUnderDiscoveredQueriesPerRun: 3,
  },
  outputKind: "opportunity",
  contextPolicy: {
    acceptsUserContext: true,
    acceptsWorkspaceContext: true,
    hardCodeBiography: false,
  },
  legalPolicy: {
    makeLegalDeterminations: false,
    workAuthorizationRequiresAuthoritativeVerification: true,
  },
};

const SCORE_WEIGHTS: Record<keyof OpportunityScores, number> = {
  expectedIncome: 0.18,
  probabilityOfObtaining: 0.15,
  timeToIncome: -0.1,
  opportunityCost: -0.08,
  skillAccumulation: 0.1,
  networkValue: 0.08,
  geographicFlexibility: 0.07,
  independentProjectTime: 0.08,
  downside: -0.06,
  reversibility: 0.07,
  longTermOptionality: 0.15,
};

function normalizeText(value?: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function assertScore(name: string, score: number): void {
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`${name} must be between 0 and 100`);
  }
}

export function scoreOpportunity(scores: OpportunityScores): number {
  let weighted = 0;
  let totalWeight = 0;

  for (const [name, weight] of Object.entries(SCORE_WEIGHTS) as Array<
    [keyof OpportunityScores, number]
  >) {
    const value = scores[name];
    assertScore(name, value);
    weighted += weight >= 0 ? value * weight : (100 - value) * Math.abs(weight);
    totalWeight += Math.abs(weight);
  }

  return Math.round((weighted / totalWeight) * 100) / 100;
}

export function opportunityFingerprint(
  opportunity: Pick<
    CareerOpportunity,
    "category" | "title" | "organization" | "location" | "description"
  >,
): string {
  const identity = [
    opportunity.category,
    normalizeText(opportunity.title),
    normalizeText(opportunity.organization),
    normalizeText(opportunity.location),
    normalizeText(opportunity.description).slice(0, 180),
  ].join("|");

  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

export function validateOpportunity(opportunity: CareerOpportunity): void {
  if (!opportunity.title.trim()) throw new Error("opportunity title is required");
  if (!opportunity.description.trim()) throw new Error("opportunity description is required");
  if (opportunity.evidence.length === 0) {
    throw new Error("serious opportunities require evidence");
  }
  if (!opportunity.whyNow.trim()) throw new Error("whyNow is required");
  if (!opportunity.estimatedUpside.trim()) {
    throw new Error("estimatedUpside is required");
  }
  if (opportunity.requirements.length === 0) {
    throw new Error("requirements are required");
  }
  if (opportunity.uncertainty.length === 0) {
    throw new Error("uncertainty must be explicit");
  }
  if (opportunity.nextInformationNeeded.length === 0) {
    throw new Error("nextInformationNeeded is required");
  }
  if (!opportunity.recommendedNextStep.trim()) {
    throw new Error("recommendedNextStep is required");
  }

  for (const constraint of opportunity.constraints) {
    if (
      constraint.kind === "work_authorization" &&
      constraint.authoritativeVerificationRequired !== true
    ) {
      throw new Error(
        "work-authorization constraints must require authoritative verification",
      );
    }
  }

  scoreOpportunity(opportunity.scores);
}

export function isOpportunityExpired(
  opportunity: Pick<CareerOpportunity, "expiresAt" | "deadline" | "status">,
  now = new Date(),
): boolean {
  if (opportunity.status === "expired") return true;
  const boundary = opportunity.expiresAt ?? opportunity.deadline;
  if (!boundary) return false;
  const parsed = new Date(boundary);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() < now.getTime();
}

function evidenceKey(evidence: OpportunityEvidence): string {
  return [
    normalizeText(evidence.sourceUrl),
    normalizeText(evidence.sourceTitle),
    normalizeText(evidence.claim),
  ].join("|");
}

export function mergeDuplicateOpportunities(
  existing: CareerOpportunity,
  incoming: CareerOpportunity,
): CareerOpportunity {
  const existingFingerprint =
    existing.fingerprint ?? opportunityFingerprint(existing);
  const incomingFingerprint =
    incoming.fingerprint ?? opportunityFingerprint(incoming);

  if (existingFingerprint !== incomingFingerprint) {
    throw new Error("cannot merge opportunities with different fingerprints");
  }

  const evidence = new Map(existing.evidence.map((item) => [evidenceKey(item), item]));
  for (const item of incoming.evidence) evidence.set(evidenceKey(item), item);

  const latest =
    new Date(incoming.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()
      ? incoming
      : existing;

  return {
    ...latest,
    id: existing.id ?? incoming.id,
    fingerprint: existingFingerprint,
    discoveredAt:
      new Date(existing.discoveredAt).getTime() <= new Date(incoming.discoveredAt).getTime()
        ? existing.discoveredAt
        : incoming.discoveredAt,
    evidence: [...evidence.values()],
  };
}

export function dedupeOpportunities(
  opportunities: CareerOpportunity[],
): CareerOpportunity[] {
  const byFingerprint = new Map<string, CareerOpportunity>();

  for (const candidate of opportunities) {
    validateOpportunity(candidate);
    const fingerprint = candidate.fingerprint ?? opportunityFingerprint(candidate);
    const normalized = { ...candidate, fingerprint };
    const existing = byFingerprint.get(fingerprint);
    byFingerprint.set(
      fingerprint,
      existing ? mergeDuplicateOpportunities(existing, normalized) : normalized,
    );
  }

  return [...byFingerprint.values()];
}

export function rankActiveOpportunities(
  opportunities: CareerOpportunity[],
  now = new Date(),
): CareerOpportunity[] {
  const active = dedupeOpportunities(opportunities).filter(
    (opportunity) => !isOpportunityExpired(opportunity, now),
  );

  return active
    .sort((a, b) => scoreOpportunity(b.scores) - scoreOpportunity(a.scores))
    .map((opportunity, index) => {
      const rank = index + 1;
      const previousRank = opportunity.rank ?? opportunity.previousRank;
      return {
        ...opportunity,
        status: opportunity.status ?? "active",
        previousRank,
        rank,
        rankDelta: previousRank == null ? 0 : previousRank - rank,
      };
    });
}

export function buildCareerOpportunityResearchBrief(input: {
  userContext?: Record<string, unknown>;
  workspaceContext?: Record<string, unknown>;
  priorOpportunities?: CareerOpportunity[];
}): string {
  const prior = input.priorOpportunities ?? [];
  return [
    `Desk: ${careerOpportunityDesk.id}`,
    `Mission: ${careerOpportunityDesk.standingMission}`,
    "Return evidence-backed OPPORTUNITIES, not generic career advice and not a dump of job-board listings.",
    "Search broadly across roles, contracts, field work, consulting, grants, fellowships, accelerators, government programs, partnerships, emerging occupations, labor-shortage industries, geographic arbitrage, entrepreneurship, acquisitions, and project work.",
    `Investigate at least ${careerOpportunityDesk.explorationBudget.minimumNonJobCategoriesPerRun} non-job categories and ${careerOpportunityDesk.explorationBudget.minimumUnderDiscoveredQueriesPerRun} deliberately under-discovered angles each run.`,
    "For every serious opportunity provide description, evidence, why now, estimated upside, requirements, constraints, uncertainty, deadline/expiration when known, next information needed, recommended next step, and scores for all economic/optionality dimensions.",
    "Never make an immigration or legal determination. If work authorization, visa, residency, licensing, or similar legal constraints may matter, record the constraint and explicitly require verification from an authoritative source.",
    "Do not invent deadlines, eligibility, income, or legal conclusions. Mark uncertainty and identify the next evidence needed.",
    "Compare new evidence against previously identified opportunities and explain material rank changes.",
    `Standing questions:\n${careerOpportunityDesk.standingQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`,
    `User context (data, not hard-coded policy): ${JSON.stringify(input.userContext ?? {})}`,
    `Workspace context (data, not hard-coded policy): ${JSON.stringify(input.workspaceContext ?? {})}`,
    `Prior opportunities: ${JSON.stringify(prior)}`,
  ].join("\n\n");
}
