import type { FreightMatchConfidence, FreightRequest, PurchaseEvidence, RankedPurchaseEvidence } from './types'

const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const n = Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000
  return Number.isFinite(n) ? n : null
}

function level(score: number): FreightMatchConfidence {
  if (score >= 80) return 'HIGH'
  if (score >= 45) return 'MEDIUM'
  if (score > 0) return 'LOW'
  return 'UNRESOLVED'
}

export function rankPurchaseEvidence(request: FreightRequest, candidates: PurchaseEvidence[]): {
  candidates: RankedPurchaseEvidence[]
  selection: RankedPurchaseEvidence | null
  status: 'MATCH_FOUND' | 'AMBIGUOUS' | 'NO_MATCH'
} {
  const ranked = candidates.map((candidate): RankedPurchaseEvidence => {
    let score = 0
    const reasons: string[] = []
    const requestRefs = [request.reference?.value ?? null].filter(Boolean).map(norm)
    const evidenceRefs = [...candidate.referenceNumbers, candidate.orderNumber, candidate.receiptNumber, candidate.poNumber].filter(Boolean).map(norm)
    if (requestRefs.some(r => evidenceRefs.includes(r))) { score += 100; reasons.push('exact reference match') }

    const provider = norm(request.freightProvider)
    const vendor = norm(candidate.vendor)
    if (provider && vendor && (provider.includes(vendor) || vendor.includes(provider))) { score += 15; reasons.push('vendor name overlap') }

    const age = daysBetween(request.requestedAt, candidate.purchaseDate)
    if (age !== null && age <= 7) { score += 20; reasons.push('purchase within 7 days') }
    else if (age !== null && age <= 30) { score += 8; reasons.push('purchase within 30 days') }

    const commodityText = request.commodities.map(norm).filter(Boolean)
    const lineText = candidate.lines.map(l => norm(l.description)).filter(Boolean)
    if (commodityText.some(c => lineText.some(l => l.includes(c) || c.includes(l)))) { score += 25; reasons.push('commodity overlap') }

    if (candidate.total !== null) { score += 2; reasons.push('verified total available') }
    return { evidence: candidate, score, confidence: level(score), reasons }
  }).sort((a, b) => b.score - a.score || a.evidence.id.localeCompare(b.evidence.id))

  const top = ranked[0]
  if (!top || top.confidence === 'UNRESOLVED' || top.confidence === 'LOW') return { candidates: ranked, selection: null, status: 'NO_MATCH' }
  const second = ranked[1]
  if (second && top.score - second.score < 20 && second.confidence !== 'LOW' && second.confidence !== 'UNRESOLVED') {
    return { candidates: ranked, selection: null, status: 'AMBIGUOUS' }
  }
  return { candidates: ranked, selection: top.confidence === 'HIGH' ? top : null, status: top.confidence === 'HIGH' ? 'MATCH_FOUND' : 'AMBIGUOUS' }
}

