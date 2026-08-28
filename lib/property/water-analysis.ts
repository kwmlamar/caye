export type WaterScenarioInput = {
  label: string
  catchmentAreaSqFt: number
  rainfallInches: number
  collectionEfficiency: number
  storageCapacityGallons: number
  startingStorageGallons: number
  dailyDemandGallons: number
}

export type WaterScenarioResult = {
  label: string
  capturedGallons: number
  availableBeforeOverflowGallons: number
  overflowGallons: number
  endingStorageGallons: number
  storageRunwayDays: number
  demandCoveredDaysByRainfall: number
  assumptions: {
    rainfallInches: number
    collectionEfficiency: number
    dailyDemandGallons: number
  }
}

const GALLONS_PER_SQFT_INCH = 0.623

function finite(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}`)
  }
  return value
}

/**
 * Deterministic rainwater/storage arithmetic only. This deliberately does not
 * claim potable-water safety, pipe sizing, hydraulic adequacy, structural
 * capacity, future rainfall, or regulatory compliance.
 */
export function analyzeWaterScenario(input: WaterScenarioInput): WaterScenarioResult {
  if (!input || typeof input !== 'object') throw new Error('water scenario input is required')
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 120) : 'scenario'
  const catchmentAreaSqFt = finite('catchmentAreaSqFt', input.catchmentAreaSqFt, 1, 10_000_000)
  const rainfallInches = finite('rainfallInches', input.rainfallInches, 0, 100)
  const collectionEfficiency = finite('collectionEfficiency', input.collectionEfficiency, 0.01, 1)
  const storageCapacityGallons = finite('storageCapacityGallons', input.storageCapacityGallons, 1, 100_000_000)
  const startingStorageGallons = finite('startingStorageGallons', input.startingStorageGallons, 0, storageCapacityGallons)
  const dailyDemandGallons = finite('dailyDemandGallons', input.dailyDemandGallons, 0.01, 10_000_000)

  const capturedGallons = catchmentAreaSqFt * rainfallInches * GALLONS_PER_SQFT_INCH * collectionEfficiency
  const availableBeforeOverflowGallons = Math.max(0, storageCapacityGallons - startingStorageGallons)
  const overflowGallons = Math.max(0, capturedGallons - availableBeforeOverflowGallons)
  const endingStorageGallons = Math.min(storageCapacityGallons, startingStorageGallons + capturedGallons)

  return {
    label,
    capturedGallons,
    availableBeforeOverflowGallons,
    overflowGallons,
    endingStorageGallons,
    storageRunwayDays: endingStorageGallons / dailyDemandGallons,
    demandCoveredDaysByRainfall: capturedGallons / dailyDemandGallons,
    assumptions: { rainfallInches, collectionEfficiency, dailyDemandGallons },
  }
}

export function compareWaterScenarios(a: WaterScenarioInput, b: WaterScenarioInput) {
  const first = analyzeWaterScenario(a)
  const second = analyzeWaterScenario(b)
  return {
    scenarios: [first, second] as const,
    delta: {
      capturedGallons: second.capturedGallons - first.capturedGallons,
      endingStorageGallons: second.endingStorageGallons - first.endingStorageGallons,
      storageRunwayDays: second.storageRunwayDays - first.storageRunwayDays,
      overflowGallons: second.overflowGallons - first.overflowGallons,
    },
    safetyNote: 'Water-balance arithmetic only; no potable-water, hydraulic, structural, rainfall-forecast, or code-compliance claim is made.',
  }
}
