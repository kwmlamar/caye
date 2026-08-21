import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { validateAgainstSchema } from './schema-validate'

const GET_CUSTOMER_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
}

describe('validateAgainstSchema', () => {
  it('accepts a valid object matching a simple schema', () => {
    expect(validateAgainstSchema(GET_CUSTOMER_SCHEMA, { query: 'Karenda' })).toEqual({ valid: true, errors: [] })
  })

  it('rejects a missing required property — the untrusted-input case a text-parsed tool call can hit', () => {
    const result = validateAgainstSchema(GET_CUSTOMER_SCHEMA, {})
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('query')
  })

  it('rejects a wrong-typed property (model hallucinated a number instead of a string)', () => {
    const result = validateAgainstSchema(GET_CUSTOMER_SCHEMA, { query: 12345 })
    expect(result.valid).toBe(false)
  })

  it('rejects a non-object value entirely (model returned an array or a bare string as input)', () => {
    expect(validateAgainstSchema(GET_CUSTOMER_SCHEMA, 'not an object').valid).toBe(false)
    expect(validateAgainstSchema(GET_CUSTOMER_SCHEMA, ['array']).valid).toBe(false)
    expect(validateAgainstSchema(GET_CUSTOMER_SCHEMA, null).valid).toBe(false)
  })

  it('validates nested objects and arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    }
    expect(validateAgainstSchema(schema, { name: 'x', tags: ['a', 'b'] }).valid).toBe(true)
    expect(validateAgainstSchema(schema, { name: 'x', tags: ['a', 5] }).valid).toBe(false)
  })

  it('validates enum membership (e.g. add_team_member\'s role field)', () => {
    const schema = { type: 'object', properties: { role: { type: 'string', enum: ['owner', 'staff', 'driver'] } }, required: ['role'] }
    expect(validateAgainstSchema(schema, { role: 'staff' }).valid).toBe(true)
    expect(validateAgainstSchema(schema, { role: 'admin' }).valid).toBe(false)
  })

  it('accepts extra properties not declared in the schema (permissive, not strict-mode)', () => {
    expect(validateAgainstSchema(GET_CUSTOMER_SCHEMA, { query: 'x', extra: 'field' }).valid).toBe(true)
  })

  it('fails closed on an unrecognized declared schema type rather than silently passing', () => {
    const schema = { type: 'object', properties: { x: { type: 'weird_type' } }, required: ['x'] }
    expect(validateAgainstSchema(schema, { x: 'anything' }).valid).toBe(false)
  })

  it('accepts a number and integer correctly, rejects NaN', () => {
    expect(validateAgainstSchema({ type: 'number' }, 3.5).valid).toBe(true)
    expect(validateAgainstSchema({ type: 'integer' }, 3.5).valid).toBe(false)
    expect(validateAgainstSchema({ type: 'number' }, NaN).valid).toBe(false)
  })

  it('accepts boolean correctly', () => {
    expect(validateAgainstSchema({ type: 'boolean' }, true).valid).toBe(true)
    expect(validateAgainstSchema({ type: 'boolean' }, 'true').valid).toBe(false)
  })
})
