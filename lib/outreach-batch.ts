export interface OutreachBatchCandidate {
  id: string
  first_touch_sent_at: string | null
  last_touch_sent_at?: string | null
  created_at: string
}

/**
 * Reserve half the tick for each durable class. Unused capacity spills over.
 * Oldest-first within a class bounds wait time under sustained inflow.
 */
export function selectOutreachBatch<T extends OutreachBatchCandidate>(rows: T[], limit: number): T[] {
  const fresh = rows.filter((row) => row.first_touch_sent_at === null)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  const cadence = rows.filter((row) => row.first_touch_sent_at !== null)
    .sort((a, b) => Date.parse(a.last_touch_sent_at ?? a.first_touch_sent_at!) - Date.parse(b.last_touch_sent_at ?? b.first_touch_sent_at!))
  const reserved = Math.floor(limit / 2)
  const pickedFresh = fresh.slice(0, reserved)
  const pickedCadence = cadence.slice(0, reserved)
  let remaining = limit - pickedFresh.length - pickedCadence.length
  const spillFresh = fresh.slice(pickedFresh.length, pickedFresh.length + remaining)
  remaining -= spillFresh.length
  const spillCadence = cadence.slice(pickedCadence.length, pickedCadence.length + remaining)
  return [...pickedFresh, ...pickedCadence, ...spillFresh, ...spillCadence]
}
