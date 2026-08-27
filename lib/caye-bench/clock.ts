export class BenchClock {
  private currentMs: number

  constructor(initialTime: string) {
    const parsed = Date.parse(initialTime)
    if (!Number.isFinite(parsed)) throw new Error(`Invalid bench initial time: ${initialTime}`)
    this.currentMs = parsed
  }

  now(): string {
    return new Date(this.currentMs).toISOString()
  }

  advanceTo(iso: string): string {
    const next = Date.parse(iso)
    if (!Number.isFinite(next)) throw new Error(`Invalid bench event time: ${iso}`)
    if (next < this.currentMs) {
      throw new Error(`Bench time cannot move backwards: ${iso} < ${this.now()}`)
    }
    this.currentMs = next
    return this.now()
  }

  advanceMs(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid bench duration: ${ms}`)
    this.currentMs += ms
    return this.now()
  }
}
