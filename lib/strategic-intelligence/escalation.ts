import type { StrategicEscalationLevel, StrategicEvidence } from "./types";

export type EscalationInput = {
  relevance: number;
  materiality: number;
  urgency: number;
  evidence: StrategicEvidence[];
  /** Canonical Research Runtime question to deepen/cross-check. */
  researchQuestionId?: string;
  crossDomainCorroboration?: boolean;
  actionable?: boolean;
};

// Stale and contradicted evidence are not merely discounted — they are excluded from the
// usable pool entirely. A flat confidence subtraction can be overwhelmed by a high base
// confidence; exclusion cannot. This is what hard-gates strength (and therefore the
// escalation level, since strength collapses to 0 when nothing usable remains) instead of
// just nudging it down.
const isUsable = (e: StrategicEvidence) => !e.stale && !e.contradicted;

export function evidenceStrength(evidence: StrategicEvidence[]): number {
  const usable = evidence.filter(isUsable);
  if (!usable.length) return 0;
  const independent = usable.reduce((n, e) => n + Math.max(0, e.independentSourceCount), 0);
  const avgConfidence = usable.reduce((n, e) => n + e.confidence, 0) / usable.length;
  return Math.max(0, Math.min(1, avgConfidence + Math.min(independent, 3) * 0.08));
}

export function classifyStrategicEscalation(input: EscalationInput): StrategicEscalationLevel {
  const strength = evidenceStrength(input.evidence);
  if (input.relevance < 0.25 || input.materiality < 0.2) return 0;
  if (strength < 0.35) return 1;
  if (strength < 0.55 || input.materiality < 0.55) return 2;
  if (!input.crossDomainCorroboration || strength < 0.7) return 3;
  if (!input.actionable) return 3;
  if (input.urgency < 0.8 || input.materiality < 0.75 || strength < 0.82) return 4;
  return 5;
}

export function shouldInterrupt(level: StrategicEscalationLevel): boolean {
  return level === 5;
}
