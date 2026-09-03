import { describe, expect, it } from 'vitest'

import {
  CREW_DAY_DEFAULTS,
  isMuted,
  nextCrewDayQuestion,
  resolveAttentionOverride,
  resolveCrewDayPolicy,
  unconfirmed,
  type PolicyValue,
} from './domain-policy'

function crewDayConfig(crewDay: Record<string, unknown>): Record<string, unknown> {
  return { policy: { crew_day: crewDay } }
}

function attentionConfig(attention: Record<string, unknown>): Record<string, unknown> {
  return { policy: { attention } }
}

describe('resolveCrewDayPolicy', () => {
  it('returns every default with source "default" when config is empty', () => {
    const policy = resolveCrewDayPolicy({})

    expect(policy.breakMinutes).toEqual({ value: CREW_DAY_DEFAULTS.breakMinutes, source: 'default' })
    expect(policy.standardStart).toEqual({ value: CREW_DAY_DEFAULTS.standardStart, source: 'default' })
    expect(policy.standardEnd).toEqual({ value: CREW_DAY_DEFAULTS.standardEnd, source: 'default' })
    expect(policy.overtimeEnabled).toEqual({ value: CREW_DAY_DEFAULTS.overtimeEnabled, source: 'default' })
    expect(policy.reporterLogsOwnTime).toEqual({
      value: CREW_DAY_DEFAULTS.reporterLogsOwnTime,
      source: 'default',
    })
    expect(policy.refuseDuplicates).toEqual({ value: CREW_DAY_DEFAULTS.refuseDuplicates, source: 'default' })
  })

  it('returns every default with source "default" when config is null', () => {
    const policy = resolveCrewDayPolicy(null)
    expect(Object.values(policy).every((v) => v.source === 'default')).toBe(true)
  })

  it('returns every default with source "default" when config is undefined', () => {
    const policy = resolveCrewDayPolicy(undefined)
    expect(Object.values(policy).every((v) => v.source === 'default')).toBe(true)
  })

  it('returns a workspace-set value with source "workspace"', () => {
    const policy = resolveCrewDayPolicy(
      crewDayConfig({
        break_minutes: 30,
        standard_start: '06:30',
        standard_end: '15:00',
        overtime_enabled: true,
        reporter_logs_own_time: true,
        refuse_duplicates: false,
      })
    )

    expect(policy.breakMinutes).toEqual({ value: 30, source: 'workspace' })
    expect(policy.standardStart).toEqual({ value: '06:30', source: 'workspace' })
    expect(policy.standardEnd).toEqual({ value: '15:00', source: 'workspace' })
    expect(policy.overtimeEnabled).toEqual({ value: true, source: 'workspace' })
    expect(policy.reporterLogsOwnTime).toEqual({ value: true, source: 'workspace' })
    expect(policy.refuseDuplicates).toEqual({ value: false, source: 'workspace' })
  })

  describe('malformed workspace values fall back to the default rather than being trusted', () => {
    it('rejects a string where break_minutes wants a number', () => {
      const policy = resolveCrewDayPolicy(crewDayConfig({ break_minutes: 'sixty' }))
      expect(policy.breakMinutes).toEqual({ value: CREW_DAY_DEFAULTS.breakMinutes, source: 'default' })
    })

    it('rejects a non-finite number for break_minutes', () => {
      expect(resolveCrewDayPolicy(crewDayConfig({ break_minutes: NaN })).breakMinutes.source).toBe('default')
      expect(resolveCrewDayPolicy(crewDayConfig({ break_minutes: Infinity })).breakMinutes.source).toBe(
        'default'
      )
    })

    it('rejects an unparseable time format like "7am"', () => {
      const policy = resolveCrewDayPolicy(crewDayConfig({ standard_start: '7am' }))
      expect(policy.standardStart).toEqual({ value: CREW_DAY_DEFAULTS.standardStart, source: 'default' })
    })

    it('rejects an out-of-range time like "25:00"', () => {
      const policy = resolveCrewDayPolicy(crewDayConfig({ standard_start: '25:00' }))
      expect(policy.standardStart).toEqual({ value: CREW_DAY_DEFAULTS.standardStart, source: 'default' })
    })

    it('rejects an out-of-range minute like "07:75"', () => {
      const policy = resolveCrewDayPolicy(crewDayConfig({ standard_end: '07:75' }))
      expect(policy.standardEnd).toEqual({ value: CREW_DAY_DEFAULTS.standardEnd, source: 'default' })
    })

    it('rejects a number where overtime_enabled wants a boolean', () => {
      const policy = resolveCrewDayPolicy(crewDayConfig({ overtime_enabled: 1 }))
      expect(policy.overtimeEnabled).toEqual({ value: CREW_DAY_DEFAULTS.overtimeEnabled, source: 'default' })
    })

    it('rejects a string where reporter_logs_own_time wants a boolean', () => {
      const policy = resolveCrewDayPolicy(crewDayConfig({ reporter_logs_own_time: 'yes' }))
      expect(policy.reporterLogsOwnTime).toEqual({
        value: CREW_DAY_DEFAULTS.reporterLogsOwnTime,
        source: 'default',
      })
    })

    it('rejects a number where refuse_duplicates wants a boolean', () => {
      const policy = resolveCrewDayPolicy(crewDayConfig({ refuse_duplicates: 0 }))
      expect(policy.refuseDuplicates).toEqual({ value: CREW_DAY_DEFAULTS.refuseDuplicates, source: 'default' })
    })

    it('ignores a policy section that is not an object', () => {
      const policy = resolveCrewDayPolicy({ policy: { crew_day: 'not-an-object' } })
      expect(Object.values(policy).every((v) => v.source === 'default')).toBe(true)
    })

    it('ignores a config whose top-level policy is not an object', () => {
      const policy = resolveCrewDayPolicy({ policy: 'not-an-object' })
      expect(Object.values(policy).every((v) => v.source === 'default')).toBe(true)
    })
  })
})

describe('unconfirmed', () => {
  it('names exactly the keys still on defaults', () => {
    const policy = resolveCrewDayPolicy(crewDayConfig({ break_minutes: 45, overtime_enabled: true }))
    expect(unconfirmed(policy).sort()).toEqual(
      ['standardStart', 'standardEnd', 'reporterLogsOwnTime', 'refuseDuplicates'].sort()
    )
  })

  it('returns empty when all values are workspace-set', () => {
    const policy = resolveCrewDayPolicy(
      crewDayConfig({
        break_minutes: 45,
        standard_start: '06:00',
        standard_end: '14:30',
        overtime_enabled: true,
        reporter_logs_own_time: true,
        refuse_duplicates: false,
      })
    )
    expect(unconfirmed(policy)).toEqual([])
  })

  it('returns empty for an empty policy record', () => {
    expect(unconfirmed({})).toEqual([])
  })

  it('names every key when every value is still default', () => {
    const policy = resolveCrewDayPolicy({})
    expect(unconfirmed(policy).sort()).toEqual(
      ['breakMinutes', 'standardStart', 'standardEnd', 'overtimeEnabled', 'reporterLogsOwnTime', 'refuseDuplicates'].sort()
    )
  })

  it('works over an arbitrary PolicyValue record, not just crew-day policy', () => {
    const record: Record<string, PolicyValue<unknown>> = {
      a: { value: 1, source: 'workspace' },
      b: { value: 2, source: 'default' },
    }
    expect(unconfirmed(record)).toEqual(['b'])
  })
})

describe('resolveAttentionOverride', () => {
  it('returns null for an unknown key', () => {
    expect(resolveAttentionOverride(attentionConfig({ purchase_order: { priority: 'critical' } }), 'estimate')).toBeNull()
  })

  it('returns null when config is null or undefined', () => {
    expect(resolveAttentionOverride(null, 'purchase_order')).toBeNull()
    expect(resolveAttentionOverride(undefined, 'purchase_order')).toBeNull()
  })

  it('returns null when there is no attention section at all', () => {
    expect(resolveAttentionOverride({ policy: {} }, 'purchase_order')).toBeNull()
  })

  it('reads priority', () => {
    const override = resolveAttentionOverride(
      attentionConfig({ purchase_order: { priority: 'routine' } }),
      'purchase_order'
    )
    expect(override).toEqual({ priority: 'routine' })
  })

  it('reads next_action', () => {
    const override = resolveAttentionOverride(
      attentionConfig({ purchase_order: { next_action: 'Call the supplier.' } }),
      'purchase_order'
    )
    expect(override).toEqual({ nextAction: 'Call the supplier.' })
  })

  it('distinguishes an explicit next_action: null (deliberately cleared) from an absent one', () => {
    const cleared = resolveAttentionOverride(
      attentionConfig({ purchase_order: { priority: 'routine', next_action: null } }),
      'purchase_order'
    )
    expect(cleared).not.toBeNull()
    expect(cleared).toHaveProperty('nextAction', null)
    expect('nextAction' in (cleared as object)).toBe(true)

    const absent = resolveAttentionOverride(
      attentionConfig({ purchase_order: { priority: 'routine' } }),
      'purchase_order'
    )
    expect(absent).not.toBeNull()
    expect('nextAction' in (absent as object)).toBe(false)
  })

  it('ignores a non-string priority and a non-string, non-null next_action', () => {
    const override = resolveAttentionOverride(
      attentionConfig({ purchase_order: { priority: 123, next_action: 456 } }),
      'purchase_order'
    )
    expect(override).toBeNull()
  })

  it('returns null when the found entry is not an object', () => {
    expect(resolveAttentionOverride(attentionConfig({ purchase_order: 'critical' }), 'purchase_order')).toBeNull()
  })
})

describe('isMuted', () => {
  it('is true for a key present in the muted array', () => {
    expect(isMuted(attentionConfig({ muted: ['purchase_order.status_changed'] }), 'purchase_order.status_changed')).toBe(
      true
    )
  })

  it('is false for a key not present in the muted array', () => {
    expect(isMuted(attentionConfig({ muted: ['purchase_order.status_changed'] }), 'estimate.status_changed')).toBe(
      false
    )
  })

  it('is false when muted is not an array', () => {
    expect(isMuted(attentionConfig({ muted: 'purchase_order.status_changed' }), 'purchase_order.status_changed')).toBe(
      false
    )
  })

  it('is false when the attention section is missing entirely', () => {
    expect(isMuted({ policy: {} }, 'purchase_order.status_changed')).toBe(false)
    expect(isMuted(null, 'purchase_order.status_changed')).toBe(false)
    expect(isMuted(undefined, 'purchase_order.status_changed')).toBe(false)
  })
})

describe('nextCrewDayQuestion', () => {
  const defaults = resolveCrewDayPolicy(null)
  const quiet = { reporterNamed: false, breakStated: true, longestShiftHours: 8 }

  it('says nothing when no default actually shaped the day', () => {
    // Asking about an assumption nobody's day depended on is noise, and noise
    // is how someone standing on a roof stops answering.
    expect(nextCrewDayQuestion(defaults, quiet)).toBeNull()
  })

  it('asks who is on the timesheet before anything else', () => {
    // Who is on the timesheet decides who gets paid, so it outranks a break.
    const q = nextCrewDayQuestion(defaults, { reporterNamed: true, breakStated: false, longestShiftHours: 9 })
    expect(q?.key).toBe('reporter_logs_own_time')
  })

  it('asks about the break only when the default decided it', () => {
    expect(nextCrewDayQuestion(defaults, { ...quiet, breakStated: false })?.key).toBe('break_minutes')
    expect(nextCrewDayQuestion(defaults, { ...quiet, breakStated: true })).toBeNull()
  })

  it('raises overtime only on a day long enough for it to matter', () => {
    expect(nextCrewDayQuestion(defaults, { ...quiet, longestShiftHours: 8 })).toBeNull()
    expect(nextCrewDayQuestion(defaults, { ...quiet, longestShiftHours: 9.5 })?.key).toBe('overtime_enabled')
  })

  it('stops asking once the business has answered', () => {
    // The answer sticking is the whole point — a question re-asked daily is
    // worse than never having asked.
    const answered = resolveCrewDayPolicy({
      policy: { crew_day: { break_minutes: 30, reporter_logs_own_time: true, overtime_enabled: false } },
    })
    expect(nextCrewDayQuestion(answered, { reporterNamed: true, breakStated: false, longestShiftHours: 10 })).toBeNull()
  })

  it('asks only one thing at a time', () => {
    const q = nextCrewDayQuestion(defaults, { reporterNamed: true, breakStated: false, longestShiftHours: 12 })
    expect(q).not.toBeNull()
    expect(typeof q?.question).toBe('string')
  })
})
