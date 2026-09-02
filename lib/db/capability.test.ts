import { describe, it, expect } from 'vitest'
import {
  asCapabilityFailure,
  capabilityUnavailable,
  isMissingDatabaseObject,
  MissingDatabaseCapabilityError,
  DATABASE_CAPABILITIES,
  type DatabaseCapability,
} from './capability'
import { REPO_MIGRATIONS } from './migration-manifest'

describe('isMissingDatabaseObject', () => {
  it.each([
    ['42883', 'undefined_function — a missing RPC'],
    ['42P01', 'undefined_table'],
    ['42704', 'undefined_object'],
    ['PGRST202', 'PostgREST cannot find the function'],
    ['PGRST205', 'PostgREST cannot find the table'],
  ])('recognises %s (%s)', (code) => {
    expect(isMissingDatabaseObject({ code, message: 'boom' })).toBe(true)
  })

  it.each([
    ['23505', 'unique violation'],
    ['23503', 'foreign key violation'],
    ['40001', 'serialization failure'],
    ['57014', 'statement timeout'],
    ['P0001', 'raise exception from a guard'],
    ['42501', 'insufficient privilege'],
  ])('does NOT treat %s (%s) as a missing capability', (code) => {
    expect(isMissingDatabaseObject({ code, message: 'boom' })).toBe(false)
  })

  it.each([null, undefined, 'a string', 42, {}, { message: 'no code' }])(
    'is false for non-database errors (%s)',
    (value) => {
      expect(isMissingDatabaseObject(value)).toBe(false)
    }
  )
})

describe('asCapabilityFailure', () => {
  it('converts a missing-object error into a named capability failure', () => {
    const err = asCapabilityFailure('continuous_business_learning', {
      code: '42P01',
      message: 'relation "business_learning_observations" does not exist',
    })
    expect(err).toBeInstanceOf(MissingDatabaseCapabilityError)
    expect(err.capability).toBe('continuous_business_learning')
    expect(err.migration).toBe('20260901_continuous_business_learning')
    // The message must name the fix, not just the symptom.
    expect(err.message).toContain('supabase/migrations/20260901_continuous_business_learning.sql')
    expect(err.message).toContain('business_learning_observations')
  })

  it('RETHROWS anything that is not a missing object', () => {
    // This is the whole point: it is not a try/catch that eats failures. A
    // unique violation, a timeout or a permission error must reach the caller
    // untouched, or a real bug hides behind a "capability" label.
    const unrelated = { code: '23505', message: 'duplicate key' }
    expect(() => asCapabilityFailure('continuous_business_learning', unrelated)).toThrow()
    try {
      asCapabilityFailure('continuous_business_learning', unrelated)
    } catch (thrown) {
      expect(thrown).toBe(unrelated) // same object, not wrapped
    }
  })

  it('preserves the underlying error as the cause', () => {
    const cause = { code: '42883', message: 'function foo() does not exist' }
    const err = asCapabilityFailure('recommendation_outcome_observation', cause)
    expect(err.cause).toBe(cause)
  })

  it('renders a structured result callers can report without inventing data', () => {
    const err = asCapabilityFailure('domain_event_projection', {
      code: 'PGRST202',
      message: 'not found',
    })
    const result = capabilityUnavailable(err)
    expect(result.status).toBe('capability_unavailable')
    expect(result.capability).toBe('domain_event_projection')
    expect(result.migration).toBe('20260901_domain_event_projection_bridge')
    // no success field, no fabricated count — it reports a non-result
    expect(Object.keys(result).sort()).toEqual(['capability', 'error', 'migration', 'status'])
  })
})

describe('the capability registry stays honest', () => {
  it('every capability names a migration that exists in the repo', () => {
    for (const [capability, spec] of Object.entries(DATABASE_CAPABILITIES)) {
      expect(REPO_MIGRATIONS, `${capability} -> ${spec.migration}`).toContain(spec.migration)
    }
  })

  it('every capability describes what it provides', () => {
    for (const spec of Object.values(DATABASE_CAPABILITIES)) {
      expect(spec.provides.length).toBeGreaterThan(0)
    }
  })

  it('capability keys are stable identifiers, not prose', () => {
    for (const key of Object.keys(DATABASE_CAPABILITIES) as DatabaseCapability[]) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})
