import { describe, it, expect } from 'vitest'
import {
  scoreQualification,
  classifyICPFit,
  identifyPainCategory,
  generateQualificationNarrative,
  QualificationSignals,
} from './prospect-qualification'

describe('prospect qualification scoring', () => {
  describe('scoreQualification', () => {
    it('scores Bimini-like prospect (strong fit)', () => {
      const signals: QualificationSignals = {
        visibleResponseSlowness: true,
        highMessageVolume: true,
        catalogStabilityObserved: true,
        metaAccessVerified: true,
        multipleInboundChannels: 3,
        specificPainArticulated: true,
        verticalCategory: 'tour_operator',
        geographyCaribbean: true,
        separateBusinessLine: true,
        cannotAccessMeta: false,
        projectBasedBusiness: false,
        noDemonstratedInbound: false,
        untraceable: false,
      }

      const { score, breakdown } = scoreQualification(signals)
      expect(score).toBeGreaterThanOrEqual(80)
      expect(breakdown.signals['visible_response_slowness']).toBe(15)
      expect(breakdown.signals['high_message_volume']).toBe(15)
      expect(Object.keys(breakdown.penalties).length).toBe(0)
    })

    it('disqualifies when cannot access Meta', () => {
      const signals: QualificationSignals = {
        visibleResponseSlowness: true,
        highMessageVolume: true,
        catalogStabilityObserved: true,
        metaAccessVerified: false,
        multipleInboundChannels: 2,
        specificPainArticulated: true,
        verticalCategory: 'tour_operator',
        geographyCaribbean: true,
        separateBusinessLine: true,
        cannotAccessMeta: true,
        projectBasedBusiness: false,
        noDemonstratedInbound: false,
        untraceable: false,
      }

      const { score } = scoreQualification(signals)
      expect(score).toBeLessThan(40)
    })

    it('clamps score to 0-100', () => {
      const signals: QualificationSignals = {
        visibleResponseSlowness: false,
        highMessageVolume: false,
        catalogStabilityObserved: false,
        metaAccessVerified: false,
        multipleInboundChannels: 0,
        specificPainArticulated: false,
        verticalCategory: 'other',
        geographyCaribbean: false,
        separateBusinessLine: false,
        cannotAccessMeta: true,
        projectBasedBusiness: true,
        noDemonstratedInbound: true,
        untraceable: true,
      }

      const { score } = scoreQualification(signals)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    })
  })

  describe('classifyICPFit', () => {
    it('classifies strong fit when score ≥80 + meta access', () => {
      const signals: QualificationSignals = {
        visibleResponseSlowness: true,
        highMessageVolume: true,
        catalogStabilityObserved: true,
        metaAccessVerified: true,
        multipleInboundChannels: 3,
        specificPainArticulated: true,
        verticalCategory: 'tour_operator',
        geographyCaribbean: true,
        separateBusinessLine: true,
        cannotAccessMeta: false,
        projectBasedBusiness: false,
        noDemonstratedInbound: false,
        untraceable: false,
      }

      const { score, breakdown } = scoreQualification(signals)
      const fitLevel = classifyICPFit(score, signals, breakdown)
      expect(fitLevel).toBe('strong')
    })

    it('classifies disqualified when hard disqualifier present', () => {
      const signals: QualificationSignals = {
        visibleResponseSlowness: true,
        highMessageVolume: true,
        catalogStabilityObserved: true,
        metaAccessVerified: true,
        multipleInboundChannels: 3,
        specificPainArticulated: true,
        verticalCategory: 'tour_operator',
        geographyCaribbean: true,
        separateBusinessLine: true,
        cannotAccessMeta: true,
        projectBasedBusiness: false,
        noDemonstratedInbound: false,
        untraceable: false,
      }

      const { score, breakdown } = scoreQualification(signals)
      const fitLevel = classifyICPFit(score, signals, breakdown)
      expect(fitLevel).toBe('disqualified')
    })
  })

  describe('identifyPainCategory', () => {
    it('identifies slow_response_visible', () => {
      const signals: QualificationSignals = {
        visibleResponseSlowness: true,
        specificPainArticulated: true,
        highMessageVolume: false,
        catalogStabilityObserved: true,
        metaAccessVerified: true,
        multipleInboundChannels: 2,
        verticalCategory: 'tour_operator',
        geographyCaribbean: true,
        separateBusinessLine: true,
        cannotAccessMeta: false,
        projectBasedBusiness: false,
        noDemonstratedInbound: false,
        untraceable: false,
      }

      const category = identifyPainCategory(signals)
      expect(category).toBe('slow_response_visible')
    })

    it('identifies messages_pile_up', () => {
      const signals: QualificationSignals = {
        visibleResponseSlowness: false,
        specificPainArticulated: true,
        highMessageVolume: true,
        catalogStabilityObserved: true,
        metaAccessVerified: true,
        multipleInboundChannels: 3,
        verticalCategory: 'restaurant',
        geographyCaribbean: true,
        separateBusinessLine: true,
        cannotAccessMeta: false,
        projectBasedBusiness: false,
        noDemonstratedInbound: false,
        untraceable: false,
      }

      const category = identifyPainCategory(signals)
      expect(category).toBe('messages_pile_up')
    })
  })

  describe('generateQualificationNarrative', () => {
    it('mentions disqualifiers', () => {
      const signals: QualificationSignals = {
        visibleResponseSlowness: true,
        highMessageVolume: true,
        catalogStabilityObserved: true,
        metaAccessVerified: false,
        multipleInboundChannels: 3,
        specificPainArticulated: true,
        verticalCategory: 'tour_operator',
        geographyCaribbean: true,
        separateBusinessLine: true,
        cannotAccessMeta: true,
        projectBasedBusiness: false,
        noDemonstratedInbound: false,
        untraceable: false,
      }

      const { score } = scoreQualification(signals)
      const narrative = generateQualificationNarrative(signals, score, 'disqualified')
      expect(narrative).toContain('Cannot access own Meta')
    })
  })
})
