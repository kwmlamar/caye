import 'server-only'
import { runRoutineOpenAiCompatible, type RoutineInferenceConfig } from './providers/routine-openai-compatible'

/** Canonical AI boundary for the optional bounded routine-inference capability. */
export function generateRoutine(
  request: { system?: string; messages: readonly { role: 'user' | 'assistant'; content: string }[]; maxOutputTokens?: number },
  config: RoutineInferenceConfig,
) {
  return runRoutineOpenAiCompatible(request, config)
}
