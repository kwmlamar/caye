export type MetricPoint = {
  metricKey: string
  numericValue: number
  unit: string
}

export type MetricComparison = {
  metricKey: string
  unit: string
  predicted: number
  actual: number
  delta: number
  percentError: number | null
  direction: 'above_prediction' | 'below_prediction' | 'matched_prediction'
}

function normalizedUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * Deterministic prediction-vs-actual comparison.
 * V0.1 intentionally does not convert units: incompatible units are evidence
 * of an incomplete comparison, not an invitation for the model to improvise.
 */
export function compareMetric(predicted: MetricPoint, actual: MetricPoint): MetricComparison {
  if (predicted.metricKey !== actual.metricKey) throw new Error('Metric keys do not match')
  if (normalizedUnit(predicted.unit) !== normalizedUnit(actual.unit)) {
    throw new Error(`Unit mismatch for ${predicted.metricKey}: ${predicted.unit} vs ${actual.unit}`)
  }
  if (!Number.isFinite(predicted.numericValue) || !Number.isFinite(actual.numericValue)) {
    throw new Error('Metric values must be finite numbers')
  }
  const delta = actual.numericValue - predicted.numericValue
  const percentError = predicted.numericValue === 0 ? null : (delta / Math.abs(predicted.numericValue)) * 100
  return {
    metricKey: predicted.metricKey,
    unit: predicted.unit,
    predicted: predicted.numericValue,
    actual: actual.numericValue,
    delta,
    percentError,
    direction: delta === 0 ? 'matched_prediction' : delta > 0 ? 'above_prediction' : 'below_prediction',
  }
}

export function compareMetrics(predicted: readonly MetricPoint[], actual: readonly MetricPoint[]) {
  const actualByKey = new Map(actual.map((point) => [point.metricKey, point]))
  const comparisons: MetricComparison[] = []
  const missingActual: string[] = []
  const incompatible: Array<{ metricKey: string; reason: string }> = []
  for (const prediction of predicted) {
    const observed = actualByKey.get(prediction.metricKey)
    if (!observed) {
      missingActual.push(prediction.metricKey)
      continue
    }
    try {
      comparisons.push(compareMetric(prediction, observed))
    } catch (error) {
      incompatible.push({ metricKey: prediction.metricKey, reason: error instanceof Error ? error.message : 'Comparison failed' })
    }
  }
  return { comparisons, missingActual, incompatible }
}
