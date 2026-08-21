import 'server-only'

/**
 * Minimal, structural JSON-Schema validator — deliberately not a full
 * implementation (no $ref, no allOf/anyOf, no format validators). Caye's
 * real tool input schemas (surveyed across lib/caye-agent/tools/**) only
 * use object/string/number/boolean/array/integer + properties/required/enum/
 * items, so that's all this covers. Not a general-purpose library; a
 * purpose-built gate for one thing: is this untrusted, model-generated
 * argument blob shaped like what the tool declared it needs.
 *
 * WHY THIS EXISTS: with Caye's native Anthropic tool-use, the API itself
 * constrains the model's output to the declared input_schema before Caye
 * ever sees it. A CLI subscription backend answering through a text/JSON
 * protocol has no such upstream guarantee — Caye is the first and only
 * thing that will ever check whether `args` actually matches what
 * tool.execute() assumes. Per the multi-model router brief: "Treat model
 * output requesting a tool as untrusted input. Validate tool name, schema,
 * arguments, authorization, current state, and risk tier inside Caye
 * before execution."
 */

export interface SchemaValidationResult {
  valid: boolean
  errors: string[]
}

type JsonSchema = Record<string, unknown>

export function validateAgainstSchema(schema: JsonSchema, value: unknown): SchemaValidationResult {
  const errors: string[] = []
  validateNode(schema, value, '$', errors)
  return { valid: errors.length === 0, errors }
}

function validateNode(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  const type = schema.type as string | undefined
  const enumValues = schema.enum as unknown[] | undefined

  if (enumValues && !enumValues.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: expected one of ${JSON.stringify(enumValues)}, got ${JSON.stringify(value)}`)
    return
  }

  if (!type) return // untyped schema node — nothing further to check

  switch (type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${describeType(value)}`)
        return
      }
      const obj = value as Record<string, unknown>
      const required = (schema.required as string[] | undefined) ?? []
      for (const key of required) {
        if (!(key in obj) || obj[key] === undefined) {
          errors.push(`${path}.${key}: missing required property`)
        }
      }
      const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {}
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj && obj[key] !== undefined) {
          validateNode(propSchema, obj[key], `${path}.${key}`, errors)
        }
      }
      return
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${describeType(value)}`)
        return
      }
      const items = schema.items as JsonSchema | undefined
      if (items) {
        value.forEach((item, i) => validateNode(items, item, `${path}[${i}]`, errors))
      }
      return
    }
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: expected string, got ${describeType(value)}`)
      return
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`${path}: expected number, got ${describeType(value)}`)
      return
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`${path}: expected integer, got ${describeType(value)}`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${describeType(value)}`)
      return
    default:
      // Unrecognized declared type — fail closed rather than silently pass
      // an unvalidated argument through to a tool that trusts its shape.
      errors.push(`${path}: unsupported schema type '${type}'`)
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
