import 'server-only'

/**
 * Deterministic validation for arguments proposed against a registered Caye tool.
 * The schema is owned by the tool registration itself. Callers may validate a
 * proposal, but they do not get to define a second argument contract.
 */
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function validateSchema(value: unknown, schemaValue: unknown, path: string): string[] {
  const schema = objectValue(schemaValue)
  if (!schema) return []
  const errors: string[] = []

  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((candidate) => validateSchema(value, candidate, path).length === 0)) {
      errors.push(`${path} does not match any allowed schema`)
    }
    return errors
  }
  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.filter((candidate) => validateSchema(value, candidate, path).length === 0).length !== 1) {
      errors.push(`${path} must match exactly one allowed schema`)
    }
    return errors
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    errors.push(`${path} is not an allowed value`)
  }
  if ('const' in schema && !Object.is(schema.const, value)) errors.push(`${path} must equal the canonical constant`)

  const type = schema.type
  if (type === 'object') {
    const object = objectValue(value)
    if (!object) return [`${path} must be an object`]
    const properties = objectValue(schema.properties) ?? {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : []
    for (const key of required) if (!(key in object)) errors.push(`${path}.${key} is required`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!(key in properties)) errors.push(`${path}.${key} is not allowed`)
    }
    for (const [key, child] of Object.entries(object)) {
      if (key in properties) errors.push(...validateSchema(child, properties[key], `${path}.${key}`))
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path} has too few items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path} has too many items`)
    if (schema.items) value.forEach((entry, index) => errors.push(...validateSchema(entry, schema.items, `${path}[${index}]`)))
  } else if (type === 'string') {
    if (typeof value !== 'string') return [`${path} must be a string`]
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path} is too short`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path} is too long`)
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) {
      return [`${path} must be a ${type}`]
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} is below minimum`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} exceeds maximum`)
  } else if (type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path} must be a boolean`)
  }

  return errors
}

export function validateToolArgumentsAgainstSchema(
  args: unknown,
  inputSchema: unknown,
  path = 'arguments',
): string[] {
  return validateSchema(args, inputSchema, path)
}
