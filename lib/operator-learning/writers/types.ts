import type { LearningDecision } from '../audit'

export type WriteOutcome =
  | { decision: Extract<LearningDecision, 'written' | 'superseded_and_written'>; targetTable: string; targetRecordId: string; supersededRecordId: string | null; reason: string }
  | { decision: 'candidate'; reason: string }
  | { decision: 'no_op'; reason: string }
  | { decision: 'error'; reason: string }
