import { describe, expect, it } from 'vitest'

import { freightRequestEntityId } from './types'

/**
 * Regression guard for a defect that ran silently in production.
 *
 * `business_artifact_relations.target_entity_id` is `uuid not null`. Both freight
 * call sites wrote `freight:<uuid>`, which is not valid UUID syntax, so every
 * insert failed: production held **0 freight relations against 2,354 total**.
 * Detection and attachment ingestion were working the whole time — 1,177 parsed
 * email-evidence observations — and the bookkeeping meant to link them landed
 * nowhere.
 *
 * The failure was invisible because nothing reads those relations back yet. That
 * is exactly why it needs a test rather than a comment.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MESSAGE_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

describe('freightRequestEntityId', () => {
  it('strips the workflow prefix so the id is a real UUID', () => {
    expect(freightRequestEntityId(`freight:${MESSAGE_ID}`)).toBe(MESSAGE_ID)
  })

  it('leaves a bare message id untouched', () => {
    // The reconciliation path already holds the raw id; it must not be mangled.
    expect(freightRequestEntityId(MESSAGE_ID)).toBe(MESSAGE_ID)
  })

  it('never returns something the database would reject', () => {
    // The whole point: whatever goes in, what comes out is insertable into a
    // uuid column. A prefixed id reaching Postgres is the original bug.
    for (const input of [MESSAGE_ID, `freight:${MESSAGE_ID}`]) {
      expect(freightRequestEntityId(input)).toMatch(UUID)
      expect(freightRequestEntityId(input).startsWith('freight:')).toBe(false)
    }
  })

  it('is idempotent, so a value that has already been stripped survives a second pass', () => {
    const once = freightRequestEntityId(`freight:${MESSAGE_ID}`)
    expect(freightRequestEntityId(once)).toBe(once)
  })
})
