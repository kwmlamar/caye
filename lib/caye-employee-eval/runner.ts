import type { EmployeeScenarioFixture, EmployeeScenarioSnapshot } from './types'
import type { EmployeeEvalEvent } from './scenario-events'
import { FROZEN_EMPLOYEE_EVENT_STREAMS } from './scenario-events'

export interface EmployeeEvalStepContext {
  scenario: EmployeeScenarioFixture
  eventIndex: number
  priorEvents: readonly EmployeeEvalEvent[]
}

/**
 * Deliberately narrow seam between the frozen business simulation and an
 * implementation under evaluation. The evaluator never asks which helper was
 * called. It only supplies events, then inspects the adapter's observable
 * durable state/effects through snapshot().
 */
export interface EmployeeEvalAdapter {
  name: string
  reset(fixture: EmployeeScenarioFixture): Promise<void> | void
  handle(event: EmployeeEvalEvent, context: EmployeeEvalStepContext): Promise<void> | void
  snapshot(fixture: EmployeeScenarioFixture): Promise<EmployeeScenarioSnapshot> | EmployeeScenarioSnapshot
}

export async function runEmployeeScenario(
  fixture: EmployeeScenarioFixture,
  adapter: EmployeeEvalAdapter,
): Promise<EmployeeScenarioSnapshot> {
  const events = FROZEN_EMPLOYEE_EVENT_STREAMS[fixture.id as keyof typeof FROZEN_EMPLOYEE_EVENT_STREAMS]
  if (!events) throw new Error(`No frozen event stream registered for ${fixture.id}`)
  await adapter.reset(fixture)
  const priorEvents: EmployeeEvalEvent[] = []
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    await adapter.handle(event, { scenario: fixture, eventIndex: i, priorEvents })
    priorEvents.push(event)
  }
  return adapter.snapshot(fixture)
}

export async function runEmployeeFixtures(
  fixtures: readonly EmployeeScenarioFixture[],
  adapter: EmployeeEvalAdapter,
): Promise<EmployeeScenarioSnapshot[]> {
  const snapshots: EmployeeScenarioSnapshot[] = []
  for (const fixture of fixtures) snapshots.push(await runEmployeeScenario(fixture, adapter))
  return snapshots
}
