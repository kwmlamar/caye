import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { extractBusinessLearning, type ExtractLearningInput, type ExtractionResult } from './extract'

type RuntimeOverrides = {
  createClient?: () => unknown
  extract?: (input: ExtractLearningInput) => Promise<ExtractionResult>
}

let evalOverrides: RuntimeOverrides | null = null

function evalRuntimeAllowed(): boolean {
  return process.env.CAYE_EMPLOYEE_EVAL_RUNTIME === '1' || process.env.NODE_ENV === 'test'
}

/**
 * Test/evaluation-only provider boundary. Production keeps using the existing
 * Supabase service client and Anthropic extractor. The Employee Eval adapter
 * may replace only those external boundaries while exercising the real
 * learning pipeline, conflict resolver, canonicalizer, and event writer.
 */
export function installBusinessLearningEvalRuntime(overrides: RuntimeOverrides): () => void {
  if (!evalRuntimeAllowed()) {
    throw new Error('Business-learning runtime overrides are only allowed in the Employee Eval/test runtime')
  }
  if (evalOverrides) throw new Error('Business-learning eval runtime is already installed')
  evalOverrides = overrides
  return () => {
    if (evalOverrides === overrides) evalOverrides = null
  }
}

export function createBusinessLearningClient(): ReturnType<typeof createServiceClient> {
  if (evalOverrides?.createClient) return evalOverrides.createClient() as ReturnType<typeof createServiceClient>
  return createServiceClient()
}

export async function runBusinessLearningExtraction(input: ExtractLearningInput): Promise<ExtractionResult> {
  if (evalOverrides?.extract) return evalOverrides.extract(input)
  return extractBusinessLearning(input)
}
