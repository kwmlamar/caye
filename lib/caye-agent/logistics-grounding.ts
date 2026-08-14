/** Deterministic guard for exact time-to-event associations in customer drafts. */

const TIME = String.raw`(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)`
const EVENT = String.raw`(?:ferry|pickup|pick-up|transport(?:ation)?|tram|flight|arrival|departure|drop-?off)`

function canonicalTime(value: string): string {
  return value.toLowerCase().replace(/\./g, '').replace(/\s+/g, '').replace(/^0/, '')
}

function canonicalEvent(value: string): string {
  const v = value.toLowerCase().replace(/-/g, '')
  if (v.startsWith('pick')) return 'pickup'
  if (v.startsWith('transport')) return 'transport'
  if (v.startsWith('drop')) return 'dropoff'
  return v
}

export function extractLogisticsTimeClaims(text: string): Set<string> {
  const claims = new Set<string>()
  for (const line of text.split(/\n|(?<=[.!?])\s+/)) {
    const times = [...line.matchAll(new RegExp(TIME, 'gi'))]
    const events = [...line.matchAll(new RegExp(`\\b${EVENT}\\b`, 'gi'))]
    for (const timeMatch of times) {
      const timeAt = timeMatch.index ?? 0
      const nearest = events
        .map((eventMatch) => ({ match: eventMatch, distance: Math.abs((eventMatch.index ?? 0) - timeAt) }))
        .filter((event) => event.distance <= 48)
        .sort((a, b) => a.distance - b.distance)[0]?.match
      if (nearest) {
        claims.add(`${canonicalEvent(nearest[0])}:${canonicalTime(timeMatch[0])}`)
      }
    }
  }
  return claims
}

/** Returns exact event/time claims in the draft that the thread never made. */
export function unsupportedLogisticsTimeClaims(draft: string, authoritativeThread: string): string[] {
  const source = extractLogisticsTimeClaims(authoritativeThread)
  return [...extractLogisticsTimeClaims(draft)].filter((claim) => !source.has(claim))
}
