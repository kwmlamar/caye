import { describe, expect, it } from 'vitest'
import { analyzeWaterScenario, compareWaterScenarios } from './water-analysis'

describe('property water analysis', () => {
  it('calculates the mother-property full-roof planning scenario deterministically', () => {
    const result = analyzeWaterScenario({
      label: 'full roof',
      catchmentAreaSqFt: 1500,
      rainfallInches: 1,
      collectionEfficiency: 0.8,
      storageCapacityGallons: 2000,
      startingStorageGallons: 0,
      dailyDemandGallons: 450,
    })
    expect(result.capturedGallons).toBeCloseTo(747.6, 6)
    expect(result.endingStorageGallons).toBeCloseTo(747.6, 6)
    expect(result.storageRunwayDays).toBeCloseTo(1.6613333333, 6)
    expect(result.overflowGallons).toBe(0)
  })

  it('shows overflow rather than inventing storage', () => {
    const result = analyzeWaterScenario({ label: 'storm', catchmentAreaSqFt: 1500, rainfallInches: 3, collectionEfficiency: 0.9, storageCapacityGallons: 2000, startingStorageGallons: 500, dailyDemandGallons: 400 })
    expect(result.capturedGallons).toBeCloseTo(2523.15, 6)
    expect(result.endingStorageGallons).toBe(2000)
    expect(result.overflowGallons).toBeCloseTo(1023.15, 6)
  })

  it('compares current and proposed catchment without changing shared assumptions', () => {
    const shared = { rainfallInches: 1, collectionEfficiency: 0.8, storageCapacityGallons: 2000, startingStorageGallons: 0, dailyDemandGallons: 450 }
    const result = compareWaterScenarios(
      { label: 'partial catchment', catchmentAreaSqFt: 700, ...shared },
      { label: 'full catchment', catchmentAreaSqFt: 1500, ...shared },
    )
    expect(result.delta.capturedGallons).toBeCloseTo(398.72, 6)
    expect(result.delta.storageRunwayDays).toBeGreaterThan(0)
  })

  it('refuses missing, nonsensical, or impossible inputs instead of guessing', () => {
    expect(() => analyzeWaterScenario({ label: 'bad', catchmentAreaSqFt: 0, rainfallInches: 1, collectionEfficiency: 0.8, storageCapacityGallons: 2000, startingStorageGallons: 0, dailyDemandGallons: 450 })).toThrow(/catchmentAreaSqFt/)
    expect(() => analyzeWaterScenario({ label: 'bad', catchmentAreaSqFt: 1500, rainfallInches: 1, collectionEfficiency: 1.2, storageCapacityGallons: 2000, startingStorageGallons: 0, dailyDemandGallons: 450 })).toThrow(/collectionEfficiency/)
    expect(() => analyzeWaterScenario({ label: 'bad', catchmentAreaSqFt: 1500, rainfallInches: 1, collectionEfficiency: 0.8, storageCapacityGallons: 2000, startingStorageGallons: 2500, dailyDemandGallons: 450 })).toThrow(/startingStorageGallons/)
  })
})
