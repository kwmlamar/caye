/**
 * Prospect qualification scoring logic.
 *
 * Evidence-based, explainable scoring algorithm that predicts likelihood of
 * a prospect replying, booking a demo, or converting to paid. Pure functions,
 * testable deterministically without DB/network.
 *
 * Keyed to ICP.md (proven fit signals) and decisions-log 2026-08-12.
 */

export interface QualificationSignals {
  visibleResponseSlowness: boolean
  highMessageVolume: boolean
  catalogStabilityObserved: boolean
  metaAccessVerified: boolean
  multipleInboundChannels: number
  specificPainArticulated: boolean
  verticalCategory: 'tour_operator' | 'restaurant' | 'salon' | 'guesthouse' | 'other'
  geographyCaribbean: boolean
  separateBusinessLine: boolean
  cannotAccessMeta: boolean
  projectBasedBusiness: boolean
  noDemonstratedInbound: boolean
  untraceable: boolean
}

export interface ScoreBreakdown {
  signals: Record<string, number>
  penalties: Record<string, number>
  total: number
  raw: number
}

export function scoreQualification(signals: QualificationSignals): {
  score: number
  breakdown: ScoreBreakdown
} {
  const breakdown: ScoreBreakdown = {
    signals: {},
    penalties: {},
    total: 0,
    raw: 0,
  }

  let raw = 0

  if (signals.visibleResponseSlowness) {
    breakdown.signals['visible_response_slowness'] = 15
    raw += 15
  }

  if (signals.highMessageVolume) {
    breakdown.signals['high_message_volume'] = 15
    raw += 15
  }

  if (signals.catalogStabilityObserved) {
    breakdown.signals['catalog_stability'] = 10
    raw += 10
  }

  if (signals.metaAccessVerified) {
    breakdown.signals['meta_access_verified'] = 10
    raw += 10
  }

  if (signals.multipleInboundChannels >= 2) {
    const channelPoints = Math.min((signals.multipleInboundChannels - 1) * 2, 10)
    breakdown.signals['multiple_inbound_channels'] = channelPoints
    raw += channelPoints
  }

  if (signals.specificPainArticulated) {
    breakdown.signals['specific_pain_articulated'] = 10
    raw += 10
  }

  if (signals.verticalCategory === 'tour_operator') {
    breakdown.signals['tour_operator_vertical'] = 5
    raw += 5
  } else if (
    signals.verticalCategory === 'restaurant' ||
    signals.verticalCategory === 'salon' ||
    signals.verticalCategory === 'guesthouse'
  ) {
    breakdown.signals['proven_vertical'] = 3
    raw += 3
  }

  if (signals.geographyCaribbean) {
    breakdown.signals['caribbean_geography'] = 5
    raw += 5
  }

  if (signals.separateBusinessLine) {
    breakdown.signals['separate_business_line'] = 5
    raw += 5
  }

  if (signals.cannotAccessMeta) {
    breakdown.penalties['cannot_access_meta'] = -25
    raw -= 25
  }

  if (signals.projectBasedBusiness) {
    breakdown.penalties['project_based_business'] = -20
    raw -= 20
  }

  if (signals.noDemonstratedInbound) {
    breakdown.penalties['no_demonstrated_inbound'] = -15
    raw -= 15
  }

  if (signals.untraceable) {
    breakdown.penalties['untraceable_owner'] = -10
    raw -= 10
  }

  breakdown.raw = raw
  breakdown.total = Math.max(0, Math.min(100, raw))

  return {
    score: breakdown.total,
    breakdown,
  }
}

export function classifyICPFit(
  score: number,
  signals: QualificationSignals,
  breakdown: ScoreBreakdown
): 'strong' | 'moderate' | 'weak' | 'disqualified' {
  if (signals.cannotAccessMeta || signals.projectBasedBusiness || signals.noDemonstratedInbound) {
    return 'disqualified'
  }

  if (score >= 80 && signals.metaAccessVerified) {
    return 'strong'
  }

  if (score >= 60 && score < 80) {
    return 'moderate'
  }

  if (score >= 40 && score < 60) {
    return 'weak'
  }

  return 'disqualified'
}

export function identifyPainCategory(signals: QualificationSignals): string {
  if (signals.visibleResponseSlowness && signals.specificPainArticulated) {
    return 'slow_response_visible'
  }
  if (signals.highMessageVolume && signals.specificPainArticulated) {
    return 'messages_pile_up'
  }
  if (signals.specificPainArticulated) {
    return 'articulated_pain'
  }
  if (signals.visibleResponseSlowness) {
    return 'slow_response'
  }
  if (signals.highMessageVolume) {
    return 'message_volume'
  }
  return 'unknown'
}

export function generateQualificationNarrative(
  signals: QualificationSignals,
  score: number,
  fitLevel: string
): string {
  const parts: string[] = []

  if (signals.cannotAccessMeta) {
    parts.push('Cannot access own Meta account (onboarding blocker).')
  }
  if (signals.projectBasedBusiness) {
    parts.push('Project/custom-based business (needs back-office layer, not front-desk fit).')
  }
  if (signals.noDemonstratedInbound) {
    parts.push('No demonstrated inbound volume (no pain = no urgency).')
  }
  if (signals.untraceable) {
    parts.push('Owner/contact untraceable (high bounce risk).')
  }

  const positives: string[] = []
  if (signals.visibleResponseSlowness) positives.push('visible slow responses')
  if (signals.highMessageVolume) positives.push('message volume')
  if (signals.catalogStabilityObserved) positives.push('stable catalog')
  if (signals.metaAccessVerified) positives.push('confirmed Meta access')
  if (signals.multipleInboundChannels >= 2) positives.push(`${signals.multipleInboundChannels} inbound channels`)
  if (signals.specificPainArticulated) positives.push('specific pain articulated')
  if (signals.separateBusinessLine) positives.push('separate business line')

  if (positives.length > 0) {
    parts.push(`Signals: ${positives.join(', ')}.`)
  }

  if (signals.verticalCategory === 'tour_operator' && signals.geographyCaribbean) {
    parts.push('Caribbean tour operator (proven ICP from Bimini pilot).')
  }

  parts.push(`Score: ${score}/100, fit level: ${fitLevel}.`)

  return parts.filter((p) => p).join(' ')
}
