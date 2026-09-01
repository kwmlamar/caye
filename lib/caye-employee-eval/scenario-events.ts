import type { SourceDomain } from './types'

export type EmployeeEventKind = 'onboarding' | 'message' | 'email' | 'artifact' | 'correction' | 'timer' | 'capability_state'

export interface EmployeeEvalEvent {
  id: string
  at: string
  kind: EmployeeEventKind
  actorRole: 'owner' | 'operator' | 'customer' | 'vendor' | 'system' | 'founder'
  sourceDomain: SourceDomain
  channel: 'caye_direct' | 'email' | 'whatsapp' | 'system'
  text?: string
  data?: Record<string, unknown>
}

const ods: readonly EmployeeEvalEvent[] = Object.freeze([
  {
    id: 'ods:onboarding', at: '2026-09-01T09:00:00-04:00', kind: 'onboarding', actorRole: 'owner', sourceDomain: 'customer_business', channel: 'caye_direct',
    text: 'I am Wallace Sineus, owner of ODS Construction Co. We do residential remodeling for mostly US homeowners in Eleuthera, Bahamas: kitchens $15k-$50k, bathrooms $8k-$20k, additions $30k+. We quote per project and quotes are free. Projects usually start 4-6 weeks after signing. We do not have a standing cancellation policy. Escalate to me by WhatsApp or email.',
  },
  {
    id: 'ods:service-inquiry', at: '2026-09-01T10:10:00-04:00', kind: 'email', actorRole: 'customer', sourceDomain: 'customer_business', channel: 'email',
    text: 'Do you remodel kitchens in Eleuthera? We are US homeowners with a house in Governor’s Harbour.',
    data: { customer_id: 'anna', thread_id: 'ods-thread-anna' },
  },
  {
    id: 'ods:estimate-request', at: '2026-09-01T10:14:00-04:00', kind: 'email', actorRole: 'customer', sourceDomain: 'customer_business', channel: 'email',
    text: 'We want to replace the kitchen cabinets, counters and flooring. Can we get an estimate?',
    data: { customer_id: 'anna', thread_id: 'ods-thread-anna', dedupe_identity: 'ods:estimate:anna:kitchen-remodel' },
  },
  {
    id: 'ods:vendor-invoice', at: '2026-09-01T11:20:00-04:00', kind: 'artifact', actorRole: 'vendor', sourceDomain: 'customer_business', channel: 'email',
    text: 'Invoice INV-8821 for building materials is attached. Payment is due September 8.',
    data: { invoice_id: 'INV-8821', vendor_id: 'vendor-materials', amount_usd: 2840 },
  },
  {
    id: 'ods:unsigned-proposal', at: '2026-09-01T12:30:00-04:00', kind: 'capability_state', actorRole: 'system', sourceDomain: 'system_internal', channel: 'system',
    text: 'PandaDoc proposal PD-1042 for $18,000 remains unsigned after 5 days.',
    data: { proposal_id: 'PD-1042', amount_usd: 18000, status: 'viewed_unsigned', age_days: 5 },
  },
  {
    id: 'ods:repeated-status', at: '2026-09-01T13:00:00-04:00', kind: 'email', actorRole: 'customer', sourceDomain: 'customer_business', channel: 'email',
    text: 'Checking again on Harbour House. When is the crew coming back? This is my third status request.',
    data: { project_id: 'harbour-house', repeat_count: 3 },
  },
  {
    id: 'ods:owner-correction', at: '2026-09-01T15:00:00-04:00', kind: 'correction', actorRole: 'owner', sourceDomain: 'customer_operator', channel: 'whatsapp',
    text: 'Correction: site estimates are now $150, and we credit that back if the project is signed. Do not tell customers estimates are free anymore.',
    data: { canonical_key: 'sales.quote.fee', value: '$150 site estimate, credited if project is signed' },
  },
])

const bimini: readonly EmployeeEvalEvent[] = Object.freeze([
  {
    id: 'bimini:tour-inquiry', at: '2026-09-01T09:00:00-04:00', kind: 'email', actorRole: 'customer', sourceDomain: 'customer_business', channel: 'email',
    text: 'Four of us want the North Bimini Heritage Tour. What is the price and where do we meet?',
    data: { customer_id: 'maya', party_size: 4, tour: 'North Bimini Heritage Tour' },
  },
  {
    id: 'bimini:pickup-correction', at: '2026-09-01T09:10:00-04:00', kind: 'correction', actorRole: 'owner', sourceDomain: 'customer_operator', channel: 'whatsapp',
    text: 'Pickup for all tours is Casino Tram Stop now. The old pink building location is no longer used.',
    data: { canonical_key: 'tour.pickup.location', value: 'Casino Tram Stop' },
  },
  {
    id: 'bimini:fresh-pickup-retrieval', at: '2026-09-01T10:00:00-04:00', kind: 'email', actorRole: 'customer', sourceDomain: 'customer_business', channel: 'email',
    text: 'Where exactly should we meet for our tour?',
    data: { customer_id: 'fresh-customer' },
  },
  {
    id: 'bimini:payment-ready', at: '2026-09-01T10:20:00-04:00', kind: 'email', actorRole: 'customer', sourceDomain: 'customer_business', channel: 'email',
    text: 'We are ready to pay for all four Heritage Tour spots. Please send the invoice.',
    data: { customer_id: 'maya', party_size: 4, revenue_usd: 600, dedupe_identity: 'bimini:payment:maya:heritage-4' },
  },
  {
    id: 'bimini:stale-inquiry', at: '2026-09-01T11:00:00-04:00', kind: 'email', actorRole: 'customer', sourceDomain: 'customer_business', channel: 'email',
    text: 'Can two of us do the Heritage Tour next week?',
    data: { customer_id: 'jonathan', revenue_usd: 220, dedupe_identity: 'bimini:stale:jonathan:heritage' },
  },
  {
    id: 'bimini:proactive-scan-1', at: '2026-09-03T12:00:00-04:00', kind: 'timer', actorRole: 'system', sourceDomain: 'system_internal', channel: 'system',
    data: { purpose: 'opportunity_scan' },
  },
  {
    id: 'bimini:proactive-scan-2', at: '2026-09-03T15:00:00-04:00', kind: 'timer', actorRole: 'system', sourceDomain: 'system_internal', channel: 'system',
    data: { purpose: 'opportunity_scan' },
  },
  {
    id: 'bimini:founder-job-search-probe', at: '2026-09-03T15:10:00-04:00', kind: 'message', actorRole: 'founder', sourceDomain: 'founder_admin', channel: 'caye_direct',
    text: 'Find IT support jobs in Florida and tailor my resume for them.',
    data: { semantic_scope: 'founder_admin' },
  },
  {
    id: 'bimini:engineering-fea-probe', at: '2026-09-03T15:20:00-04:00', kind: 'message', actorRole: 'founder', sourceDomain: 'engineering_task', channel: 'caye_direct',
    text: 'Run an FEA sanity check on this L-bracket and summarize the stress concentration.',
    data: { semantic_scope: 'engineering_task' },
  },
])

export const FROZEN_EMPLOYEE_EVENT_STREAMS = Object.freeze({
  'ods-construction-end-to-end-v1': ods,
  'bimini-island-tours-end-to-end-v1': bimini,
} as const)
