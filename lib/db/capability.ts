/**
 * Named database capabilities, and how code reacts when one is absent.
 *
 * Caye's migrations are applied by hand, separately from the deploy. Code and
 * schema therefore land out of order routinely, and on 2026-09-02 an audit
 * found deployed callers for fourteen RPCs and two tables that do not exist in
 * production. Two of those callers run on a Vercel cron — the recommendation
 * outcome observer every 15 minutes, the business-learning pipeline every 10 —
 * and had been failing on every tick since they shipped. The failures were
 * invisible because a missing function is just an error object, identical in
 * shape to a timeout.
 *
 * This module makes that one case legible. It is deliberately NOT a try/catch
 * wrapper and deliberately NOT a fallback:
 *
 *   - it recognises only the specific Postgres/PostgREST codes that mean "this
 *     object does not exist" — every other error propagates untouched;
 *   - it names the migration that would provide the object, so the fix is
 *     "apply this migration", not "investigate";
 *   - it never invents a result. A caller that cannot do its job still does not
 *     do its job; it just says why.
 *
 * Adding an entry here is not a substitute for applying the migration. It is
 * how a deployment-ordering mistake announces itself instead of decaying into
 * a silent no-op.
 */

/** Postgres / PostgREST codes that mean "the object is not there". */
const MISSING_OBJECT_CODES = new Set([
  '42883', // undefined_function
  '42P01', // undefined_table
  '42704', // undefined_object
  'PGRST202', // PostgREST: function not found in schema cache
  'PGRST205', // PostgREST: table not found in schema cache
])

export interface DatabaseErrorLike {
  code?: string | null
  message?: string | null
  details?: string | null
}

export function isMissingDatabaseObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as DatabaseErrorLike).code
  return typeof code === 'string' && MISSING_OBJECT_CODES.has(code)
}

/**
 * Capabilities whose migration is known to be unapplied in production as of
 * 2026-09-02, with the migration that supplies each. Keep this list short and
 * delete entries once the migration is applied — a permanent entry means a
 * permanent deployment-ordering problem, which is the thing to fix.
 */
export const DATABASE_CAPABILITIES = {
  recommendation_outcome_learning: {
    migration: '20260901013500_recommendation_outcome_learning',
    provides: 'caye_recommendation_outcomes, evaluate_caye_recommendation_outcome',
  },
  recommendation_outcome_observation: {
    migration: '20260901021500_recommendation_outcome_observations',
    provides: 'caye_recommendation_outcome_observations and its claim/measure RPCs',
  },
  recommendation_decision_lifecycle: {
    migration: '20260901013000_durable_recommendation_decision_lifecycle',
    provides: 'caye_recommendation_version, caye_recommendation_execution_eligible',
  },
  continuous_business_learning: {
    migration: '20260901_continuous_business_learning',
    provides: 'business_learning_observations, business_learning_events',
  },
  business_entity_kernel: {
    migration: '20260901190000_business_entity_kernel',
    provides: 'business_entities, resolve_business_entity, upsert_business_entity_relation',
  },
  domain_event_projection: {
    migration: '20260901_domain_event_projection_bridge',
    provides: 'domain_sync_cursors, ingest_external_domain_event',
  },
} as const

export type DatabaseCapability = keyof typeof DATABASE_CAPABILITIES

export class MissingDatabaseCapabilityError extends Error {
  readonly capability: DatabaseCapability
  readonly migration: string

  constructor(capability: DatabaseCapability, cause: unknown) {
    const { migration, provides } = DATABASE_CAPABILITIES[capability]
    super(
      `database capability "${capability}" is unavailable: ${provides}. ` +
        `Apply supabase/migrations/${migration}.sql. ` +
        `Underlying error: ${(cause as DatabaseErrorLike)?.message ?? String(cause)}`
    )
    this.name = 'MissingDatabaseCapabilityError'
    this.capability = capability
    this.migration = migration
    this.cause = cause
  }
}

/**
 * Rethrows anything that is not a missing-object error; converts that one case
 * into a named capability failure.
 *
 * Use at the boundary where a caller can report "not done, and here is
 * precisely why" — never to produce a substitute result.
 */
export function asCapabilityFailure(
  capability: DatabaseCapability,
  error: unknown
): MissingDatabaseCapabilityError {
  if (!isMissingDatabaseObject(error)) {
    throw error
  }
  return new MissingDatabaseCapabilityError(capability, error)
}

export interface CapabilityUnavailable {
  status: 'capability_unavailable'
  capability: DatabaseCapability
  migration: string
  error: string
}

export function capabilityUnavailable(
  err: MissingDatabaseCapabilityError
): CapabilityUnavailable {
  return {
    status: 'capability_unavailable',
    capability: err.capability,
    migration: err.migration,
    error: err.message,
  }
}
