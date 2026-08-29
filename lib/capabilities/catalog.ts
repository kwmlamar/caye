import 'server-only'

import { attentionListCapability } from './attention-list'
import { engineeringArtifactsListCapability } from './engineering-artifacts-list'
import { goalsListCapability } from './goals-list'
import { jobSearchQueueCapability } from './job-search-queue'
import { jobSearchSummaryCapability } from './job-search-summary'
import { propertySnapshotCapability } from './property-snapshot'
import { createCapabilityRegistry } from './registry'

/**
 * The single allowlisted capability catalog for model-facing Caye operations.
 * Additions here are deliberate product surface changes, not generic function exposure.
 */
export const cayeCapabilityRegistry = createCapabilityRegistry([
  attentionListCapability,
  engineeringArtifactsListCapability,
  goalsListCapability,
  // CAY-192 — founder-only job-search operator. Never workspace-scoped;
  // see each capability's own doc comment.
  jobSearchSummaryCapability,
  jobSearchQueueCapability,
  // CAY-28 — founder-only physical property snapshot. Resolves workspace
  // scope canonically from propertyId; see property-snapshot.ts.
  propertySnapshotCapability,
])
