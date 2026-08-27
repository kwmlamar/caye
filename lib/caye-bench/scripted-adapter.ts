import type { BenchAdapter, BenchEffect, BenchInputEvent, BenchStepContext } from './types'

export type BenchScript = Record<string, BenchEffect[] | ((event: BenchInputEvent, context: BenchStepContext) => BenchEffect[])>

/**
 * Deterministic adapter for harness tests and replay fixtures. It is not a
 * stand-in for Caye's production executor; real operational scores should
 * use an adapter that calls production execution paths. This exists so the
 * benchmark machinery itself can be validated without networks or models.
 */
export class ScriptedBenchAdapter implements BenchAdapter {
  readonly name: string
  private readonly script: BenchScript

  constructor(script: BenchScript, name = 'scripted') {
    this.script = script
    this.name = name
  }

  handle(event: BenchInputEvent, context: BenchStepContext): BenchEffect[] {
    const entry = this.script[event.id]
    if (!entry) return []
    return typeof entry === 'function' ? entry(event, context) : entry.map((effect) => ({ ...effect }))
  }
}
