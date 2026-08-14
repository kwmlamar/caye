export interface NamedOperator {
  id: number
  name: string | null
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'Operator'
}

/**
 * Compact labels for the Live conversation picker. Full names remain in the
 * data model; only people who share a first name need the extra detail here.
 */
export function liveOperatorDisplayNames(operators: NamedOperator[]): Map<number, string> {
  const firstNameCounts = new Map<string, number>()
  for (const operator of operators) {
    const name = operator.name?.trim()
    if (!name) continue
    const key = firstName(name).toLocaleLowerCase()
    firstNameCounts.set(key, (firstNameCounts.get(key) ?? 0) + 1)
  }

  return new Map(
    operators.map((operator) => {
      const name = operator.name?.trim()
      if (!name) return [operator.id, 'Operator']
      const compact = firstName(name)
      return [operator.id, (firstNameCounts.get(compact.toLocaleLowerCase()) ?? 0) > 1 ? name : compact]
    })
  )
}
