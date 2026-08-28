import 'server-only'
import type { Tool } from '../types'
import { analyzeWaterScenario, compareWaterScenarios } from '@/lib/property/water-analysis'

type Scenario = {
  label: string
  catchment_area_sqft: number
  rainfall_inches: number
  collection_efficiency: number
  storage_capacity_gallons: number
  starting_storage_gallons: number
  daily_demand_gallons: number
}
type Input = { scenario: Scenario; compare_to?: Scenario }

function normalize(s: Scenario) {
  return {
    label: s.label,
    catchmentAreaSqFt: s.catchment_area_sqft,
    rainfallInches: s.rainfall_inches,
    collectionEfficiency: s.collection_efficiency,
    storageCapacityGallons: s.storage_capacity_gallons,
    startingStorageGallons: s.starting_storage_gallons,
    dailyDemandGallons: s.daily_demand_gallons,
  }
}

const scenarioSchema = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    catchment_area_sqft: { type: 'number', description: 'Horizontal projected catchment area in square feet. Never infer silently.' },
    rainfall_inches: { type: 'number', description: 'Rainfall depth to analyze in inches. This is an input scenario, not a forecast.' },
    collection_efficiency: { type: 'number', description: 'Fraction 0-1 representing runoff/capture efficiency.' },
    storage_capacity_gallons: { type: 'number' },
    starting_storage_gallons: { type: 'number' },
    daily_demand_gallons: { type: 'number', description: 'Explicit assumed or measured daily demand.' },
  },
  required: ['label','catchment_area_sqft','rainfall_inches','collection_efficiency','storage_capacity_gallons','starting_storage_gallons','daily_demand_gallons'],
  additionalProperties: false,
} as const

export const analyzePropertyWaterTool: Tool<Input> = {
  name: 'analyze_property_water',
  description: 'Run deterministic rainwater catchment and storage/runway arithmetic from explicit inputs. Use this instead of doing the arithmetic in prose. It does NOT establish potable safety, pipe sizing, pump adequacy, structural safety, future rainfall, or code compliance. Supply compare_to to compare an intervention against a baseline.',
  risk: 'read',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: { type: 'object', properties: { scenario: scenarioSchema, compare_to: scenarioSchema }, required: ['scenario'], additionalProperties: false },
  async execute(args) {
    try {
      const result = args.compare_to
        ? compareWaterScenarios(normalize(args.scenario), normalize(args.compare_to))
        : { scenario: analyzeWaterScenario(normalize(args.scenario)), safetyNote: 'Water-balance arithmetic only; no potable-water, hydraulic, structural, rainfall-forecast, or code-compliance claim is made.' }
      return { ok: true, data: result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Water analysis failed.' }
    }
  },
}
