import 'server-only'

import { attentionListCapability } from './attention-list'
import { engineeringArtifactsListCapability } from './engineering-artifacts-list'
import { goalsListCapability } from './goals-list'
import { growthSnapshotCapability } from './growth-snapshot'
import { jobSearchQueueCapability } from './job-search-queue'
import { jobSearchSummaryCapability } from './job-search-summary'
import { propertyListCapability } from './property-list'
import { propertySnapshotCapability } from './property-snapshot'
import { researchBriefCapability } from './research-brief'
import { researchClaimsCapability } from './research-claims'
import { researchStartCapability } from './research-start'
import { researchStatusCapability } from './research-status'
import { createCapabilityRegistry } from './registry'

/**
 * The single allowlisted capability catalog for model-facing Caye operations.
 * Additions here are deliberate product surface changes, not generic function exposure.
 */
export const cayeCapabilityRegistry = createCapabilityRegistry([
  attentionListCapability,
  engineeringArtifactsListCapability,
  goalsListCapability,
  // Growth Intelligence: workspace-scoped evidence/diagnosis read boundary.
  // Deliberately no execution capability in v1.
  growthSnapshotCapability,
  // CAY-192 — founder-only job-search operator. Never workspace-scoped;
  // see each capability's own doc comment.
  jobSearchSummaryCapability,
  jobSearchQueueCapability,
  // Founder/operator Research Runtime. Reads are exposed through the canonical
  // read gateway; research.start is a narrow staged-write boundary only.
  researchStatusCapability,
  researchClaimsCapability,
  researchBriefCapability,
  researchStartCapability,
  // CAY-28 — founder-only physical property intelligence. property.list is
  // discovery (fresh-session safe); property.snapshot resolves workspace
  // scope canonically from the propertyId returned by property.list.
  propertyListCapability,
  propertySnapshotCapability,
])
