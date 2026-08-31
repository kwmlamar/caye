import { describe, expect, it } from "vitest";

import {
  CAREER_OPPORTUNITY_CATEGORIES,
  CAREER_OPPORTUNITY_STANDING_QUESTIONS,
  buildCareerOpportunityResearchBrief,
  careerOpportunityDesk,
  dedupeOpportunities,
  isOpportunityExpired,
  rankActiveOpportunities,
  scoreOpportunity,
  validateOpportunity,
  type CareerOpportunity,
} from "./career-opportunity-desk";

function opportunity(
  overrides: Partial<CareerOpportunity> = {},
): CareerOpportunity {
  return {
    category: "contract_work",
    title: "AI systems implementation contract",
    organization: "Example Co",
    location: "Remote",
    description: "Implement an internal AI operations workflow for a midsize company.",
    evidence: [
      {
        sourceUrl: "https://example.com/opportunity",
        sourceTitle: "Example opportunity",
        claim: "The company is seeking a contractor for the implementation.",
        observedAt: "2026-08-31T04:00:00.000Z",
      },
    ],
    whyNow: "The company has a funded implementation window this quarter.",
    estimatedUpside: "$12k-$20k project value if scope is confirmed.",
    requirements: ["AI application engineering", "client delivery"],
    constraints: [],
    uncertainty: ["Budget and procurement timing require confirmation."],
    deadline: null,
    expiresAt: null,
    nextInformationNeeded: ["Confirm budget owner and procurement path."],
    recommendedNextStep: "Request a 20-minute scoping call with the budget owner.",
    scores: {
      expectedIncome: 82,
      probabilityOfObtaining: 60,
      timeToIncome: 25,
      opportunityCost: 25,
      skillAccumulation: 75,
      networkValue: 70,
      geographicFlexibility: 90,
      independentProjectTime: 65,
      downside: 20,
      reversibility: 90,
      longTermOptionality: 80,
    },
    discoveredAt: "2026-08-31T04:00:00.000Z",
    updatedAt: "2026-08-31T04:00:00.000Z",
    ...overrides,
  };
}

describe("career opportunity desk", () => {
  it("encodes a broad economic-opportunity mission rather than only jobs", () => {
    expect(CAREER_OPPORTUNITY_CATEGORIES).toContain("full_time_role");
    expect(CAREER_OPPORTUNITY_CATEGORIES).toContain("contract_work");
    expect(CAREER_OPPORTUNITY_CATEGORIES).toContain("grant");
    expect(CAREER_OPPORTUNITY_CATEGORIES).toContain("entrepreneurship");
    expect(CAREER_OPPORTUNITY_CATEGORIES).toContain("acquisition");
    expect(CAREER_OPPORTUNITY_STANDING_QUESTIONS).toHaveLength(7);
    expect(careerOpportunityDesk.outputKind).toBe("opportunity");
    expect(careerOpportunityDesk.contextPolicy.hardCodeBiography).toBe(false);
  });

  it("requires evidence for serious opportunities", () => {
    expect(() => validateOpportunity(opportunity({ evidence: [] }))).toThrow(
      "serious opportunities require evidence",
    );
  });

  it("requires authoritative verification for work-authorization constraints", () => {
    expect(() =>
      validateOpportunity(
        opportunity({
          constraints: [
            {
              kind: "work_authorization",
              description: "Work authorization may affect eligibility.",
            },
          ],
        }),
      ),
    ).toThrow("work-authorization constraints must require authoritative verification");

    expect(() =>
      validateOpportunity(
        opportunity({
          constraints: [
            {
              kind: "work_authorization",
              description: "Eligibility must be checked against the official program rules.",
              authoritativeVerificationRequired: true,
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("deduplicates repeated discoveries and preserves distinct evidence", () => {
    const first = opportunity();
    const second = opportunity({
      updatedAt: "2026-08-31T05:00:00.000Z",
      evidence: [
        ...first.evidence,
        {
          sourceUrl: "https://example.com/funding",
          sourceTitle: "Funding announcement",
          claim: "The implementation budget was approved.",
          observedAt: "2026-08-31T05:00:00.000Z",
        },
      ],
    });

    const result = dedupeOpportunities([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toHaveLength(2);
    expect(result[0].updatedAt).toBe("2026-08-31T05:00:00.000Z");
  });

  it("expires opportunities by explicit expiration or deadline", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    expect(
      isOpportunityExpired(
        opportunity({ expiresAt: "2026-08-31T11:59:59.000Z" }),
        now,
      ),
    ).toBe(true);
    expect(
      isOpportunityExpired(
        opportunity({ deadline: "2026-09-15T00:00:00.000Z" }),
        now,
      ),
    ).toBe(false);
  });

  it("ranks active opportunities by income, attainability, speed, learning and optionality", () => {
    const strong = opportunity({ title: "Strong contract", description: "Strong contract description" });
    const weak = opportunity({
      title: "Weak contract",
      description: "Weak contract description",
      scores: {
        expectedIncome: 25,
        probabilityOfObtaining: 20,
        timeToIncome: 90,
        opportunityCost: 90,
        skillAccumulation: 20,
        networkValue: 20,
        geographicFlexibility: 20,
        independentProjectTime: 10,
        downside: 80,
        reversibility: 20,
        longTermOptionality: 20,
      },
    });
    const expired = opportunity({
      title: "Expired contract",
      description: "Expired contract description",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });

    expect(scoreOpportunity(strong.scores)).toBeGreaterThan(scoreOpportunity(weak.scores));
    const ranked = rankActiveOpportunities(
      [weak, expired, strong],
      new Date("2026-08-31T12:00:00.000Z"),
    );
    expect(ranked.map((item) => item.title)).toEqual(["Strong contract", "Weak contract"]);
    expect(ranked.map((item) => item.rank)).toEqual([1, 2]);
  });

  it("records rank movement when prior rank information exists", () => {
    const ranked = rankActiveOpportunities([
      opportunity({
        title: "Moved up",
        description: "Moved up description",
        rank: 3,
      }),
    ]);
    expect(ranked[0].previousRank).toBe(3);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].rankDelta).toBe(2);
  });

  it("builds a research brief that explicitly rejects legal conclusions and generic advice", () => {
    const brief = buildCareerOpportunityResearchBrief({
      userContext: { skills: ["typescript", "ai"] },
      workspaceContext: { preferredMode: "remote" },
    });

    expect(brief).toContain("evidence-backed OPPORTUNITIES");
    expect(brief).toContain("not generic career advice");
    expect(brief).toContain("Never make an immigration or legal determination");
    expect(brief).toContain("authoritative source");
    expect(brief).toContain("typescript");
    expect(brief).not.toContain("Lamar");
  });
});
