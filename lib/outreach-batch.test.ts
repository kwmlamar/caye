import { describe, expect, it } from 'vitest'
import { selectOutreachBatch } from './outreach-batch'

describe('selectOutreachBatch', () => {
  it('does not starve newly sourced leads behind old active leads', () => {
    const old = Array.from({ length: 40 }, (_, i) => ({ id: `old-${i}`, first_touch_sent_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z' }))
    const fresh = { id: 'fresh', first_touch_sent_at: null, created_at: '2026-08-13T09:00:00Z' }
    expect(selectOutreachBatch([...old, fresh], 40)[0].id).toBe('fresh')
  })

  it('reserves capacity for due cadence work under continuous fresh inflow', () => {
    const fresh = Array.from({ length: 100 }, (_, i) => ({ id: `fresh-${i}`, first_touch_sent_at: null, last_touch_sent_at: null, created_at: `2026-08-13T${String(i % 24).padStart(2, '0')}:00:00Z` }))
    const followups = Array.from({ length: 20 }, (_, i) => ({ id: `follow-${i}`, first_touch_sent_at: '2026-08-01T00:00:00Z', last_touch_sent_at: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`, created_at: '2026-08-01T00:00:00Z' }))
    const selected = selectOutreachBatch([...fresh, ...followups], 40)
    expect(selected.filter((row) => row.id.startsWith('fresh-'))).toHaveLength(20)
    expect(selected.filter((row) => row.id.startsWith('follow-'))).toHaveLength(20)
  })

  it('spills unused reserved capacity to the other class', () => {
    const fresh = [{ id: 'fresh', first_touch_sent_at: null, created_at: '2026-08-13T00:00:00Z' }]
    const cadence = Array.from({ length: 39 }, (_, i) => ({ id: `follow-${i}`, first_touch_sent_at: '2026-08-01T00:00:00Z', last_touch_sent_at: '2026-08-02T00:00:00Z', created_at: '2026-08-01T00:00:00Z' }))
    expect(selectOutreachBatch([...fresh, ...cadence], 40)).toHaveLength(40)
  })
})
