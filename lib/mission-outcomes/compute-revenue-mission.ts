/**
 * Revenue mission outcome computation
 * Reads outreach_tracker and customer tables, computes weekly funnel metrics, generates intelligence
 */

import { createClient } from '@supabase/supabase-js'

interface RevenueWeeklyMetrics {
  weekEnding: Date
  prospectsDiscovered: number
  prospectsQualified: number
  qualificationRate: number
  contactsAttempted: number
  contactsSuccessful: number
  contactSuccessRate: number
  repliesReceived: number
  replyRate: number
  positiveReplies: number
  positiveReplyRate: number
  demosScheduled: number
  demoConversionRate: number
  customersAcquired: number
  customerConversionRate: number
  mrrNew: number
  mrrCumulative: number
  outreachSendsThisWeek: number
  outreachOnTrack: boolean
  primaryBottleneck: string | null
  recommendedAction: string | null
}

const BENCHMARKS = {
  qualificationRate: 80,
  contactSuccessRate: 80,
  replyRate: 20,
  positiveReplyRate: 50,
  demoConversionRate: 40,
  customerConversionRate: 30,
}

const OUTREACH_TARGET_PER_WEEK = 250 // 50/day * 5 workdays

export async function computeRevenueMissionOutcomes(
  weekEnding: Date,
  supabaseUrl: string,
  supabaseServiceKey: string
): Promise<RevenueWeeklyMetrics> {
  const client = createClient(supabaseUrl, supabaseServiceKey)

  // Week bounds
  const weekStart = new Date(weekEnding)
  weekStart.setDate(weekStart.getDate() - 6)
  weekStart.setHours(0, 0, 0, 0)

  const weekEnd = new Date(weekEnding)
  weekEnd.setHours(23, 59, 59, 999)

  // Query 1: Outreach sends (input metric)
  const { data: sends, error: sendsError } = await client
    .from('outreach_tracker')
    .select('id, qualified, response_status, demo_scheduled, customer_id')
    .gte('sent_at', weekStart.toISOString())
    .lte('sent_at', weekEnd.toISOString())

  if (sendsError) throw sendsError

  const contactsAttempted = sends?.length || 0
  const contactsSuccessful = sends?.filter((s) => s.reached === true).length || 0
  const contactSuccessRate =
    contactsAttempted > 0 ? (contactsSuccessful / contactsAttempted) * 100 : 0

  const outreachSendsThisWeek = contactsAttempted
  const outreachOnTrack = outreachSendsThisWeek >= OUTREACH_TARGET_PER_WEEK

  // Query 2: Discovery
  // Prospects discovered = all rows in outreach_tracker for this week
  // Prospects qualified = those with qualified=true
  const prospectsDiscovered = contactsAttempted
  const prospectsQualified = sends?.filter((s) => s.qualified === true).length || 0
  const qualificationRate =
    prospectsDiscovered > 0 ? (prospectsQualified / prospectsDiscovered) * 100 : 0

  // Query 3: Replies
  const repliesReceived = sends?.filter((s) => s.response_status === 'replied').length || 0
  const positiveReplies = sends?.filter((s) => s.response_status === 'positive').length || 0
  const replyRate = contactsSuccessful > 0 ? (repliesReceived / contactsSuccessful) * 100 : 0
  const positiveReplyRate =
    repliesReceived > 0 ? (positiveReplies / repliesReceived) * 100 : 0

  // Query 4: Demos and conversions
  const demosScheduled = sends?.filter((s) => s.demo_scheduled === true).length || 0
  const demoConversionRate =
    positiveReplies > 0 ? (demosScheduled / positiveReplies) * 100 : 0

  const customersAcquired = sends?.filter((s) => s.customer_id !== null).length || 0
  const customerConversionRate =
    demosScheduled > 0 ? (customersAcquired / demosScheduled) * 100 : 0

  // Query 5: Revenue
  const { data: customers, error: customersError } = await client
    .from('customers')
    .select('id, mrr')
    .eq('acquired_week_ending', weekEnding.toISOString().split('T')[0])

  if (customersError) throw customersError

  const mrrNew = customers?.reduce((sum, c) => sum + (c.mrr || 0), 0) || 0

  // Get cumulative MRR (all active subscriptions)
  const { data: allCustomers, error: allCustomersError } = await client
    .from('customers')
    .select('id, mrr')
    .eq('status', 'active')

  if (allCustomersError) throw allCustomersError

  const mrrCumulative = allCustomers?.reduce((sum, c) => sum + (c.mrr || 0), 0) || 0

  // Bottleneck detection
  const bottlenecks: Array<{ segment: string; rate: number; benchmark: number }> = []

  if (qualificationRate < BENCHMARKS.qualificationRate && prospectsDiscovered > 20) {
    bottlenecks.push({
      segment: 'qualification',
      rate: qualificationRate,
      benchmark: BENCHMARKS.qualificationRate,
    })
  }

  if (contactSuccessRate < BENCHMARKS.contactSuccessRate && contactsAttempted > 10) {
    bottlenecks.push({
      segment: 'contact_success',
      rate: contactSuccessRate,
      benchmark: BENCHMARKS.contactSuccessRate,
    })
  }

  if (replyRate < BENCHMARKS.replyRate && contactsSuccessful > 20) {
    bottlenecks.push({
      segment: 'reply',
      rate: replyRate,
      benchmark: BENCHMARKS.replyRate,
    })
  }

  if (positiveReplyRate < BENCHMARKS.positiveReplyRate && repliesReceived > 5) {
    bottlenecks.push({
      segment: 'positive_reply',
      rate: positiveReplyRate,
      benchmark: BENCHMARKS.positiveReplyRate,
    })
  }

  if (demoConversionRate < BENCHMARKS.demoConversionRate && positiveReplies > 3) {
    bottlenecks.push({
      segment: 'demo_conversion',
      rate: demoConversionRate,
      benchmark: BENCHMARKS.demoConversionRate,
    })
  }

  if (customerConversionRate < BENCHMARKS.customerConversionRate && demosScheduled > 3) {
    bottlenecks.push({
      segment: 'customer_conversion',
      rate: customerConversionRate,
      benchmark: BENCHMARKS.customerConversionRate,
    })
  }

  // Sort by impact
  bottlenecks.sort((a, b) => (a.benchmark - a.rate) - (b.benchmark - b.rate))

  const primaryBottleneck = bottlenecks[0]?.segment || null
  const recommendedAction = getRecommendedAction(primaryBottleneck, replyRate, outreachOnTrack)

  return {
    weekEnding,
    prospectsDiscovered,
    prospectsQualified,
    qualificationRate,
    contactsAttempted,
    contactsSuccessful,
    contactSuccessRate,
    repliesReceived,
    replyRate,
    positiveReplies,
    positiveReplyRate,
    demosScheduled,
    demoConversionRate,
    customersAcquired,
    customerConversionRate,
    mrrNew,
    mrrCumulative,
    outreachSendsThisWeek,
    outreachOnTrack,
    primaryBottleneck,
    recommendedAction,
  }
}

function getRecommendedAction(
  bottleneck: string | null,
  replyRate: number,
  outreachOnTrack: boolean
): string | null {
  // First: check input metric
  if (!outreachOnTrack) {
    return 'PRIORITY: Outreach volume is below 250/week target. Increase daily sends before analyzing bottlenecks.'
  }

  switch (bottleneck) {
    case 'qualification':
      return 'Tighten lead sourcing filters; too many non-ICP prospects in pipeline'

    case 'contact_success':
      return 'Audit contact data quality; verify phone/email before sending. Channel accuracy issue.'

    case 'reply':
      return 'Opener messaging not resonating. A/B test opener variants; check for spam folder issues.'

    case 'positive_reply':
      return 'Replies are engaged but not positive. Test alternative pain-point framing in opener.'

    case 'demo_conversion':
      return 'Follow-up sequence weak; improve qualification questions or call-to-action in follow-ups'

    case 'customer_conversion':
      return 'Demo-to-close gap. Audit pricing objections, onboarding friction, or product gaps from demo feedback'

    default:
      return replyRate > 0
        ? 'No major bottleneck detected. Continue monitoring; sample size may be small.'
        : null
  }
}

/**
 * Store computed metrics in revenue_mission_weekly
 */
export async function storeRevenueMissionMetrics(
  metrics: RevenueWeeklyMetrics,
  supabaseUrl: string,
  supabaseServiceKey: string
) {
  const client = createClient(supabaseUrl, supabaseServiceKey)

  const { error } = await client.from('revenue_mission_weekly').upsert(
    {
      week_ending: metrics.weekEnding,
      prospects_discovered: metrics.prospectsDiscovered,
      prospects_qualified: metrics.prospectsQualified,
      qualification_rate_pct: Math.round(metrics.qualificationRate * 100) / 100,
      contacts_attempted: metrics.contactsAttempted,
      contacts_successful: metrics.contactsSuccessful,
      contact_success_rate_pct: Math.round(metrics.contactSuccessRate * 100) / 100,
      replies_received: metrics.repliesReceived,
      reply_rate_pct: Math.round(metrics.replyRate * 100) / 100,
      positive_replies: metrics.positiveReplies,
      positive_reply_rate_pct: Math.round(metrics.positiveReplyRate * 100) / 100,
      demos_scheduled: metrics.demosScheduled,
      demo_conversion_rate_pct: Math.round(metrics.demoConversionRate * 100) / 100,
      customers_acquired: metrics.customersAcquired,
      customer_conversion_rate_pct: Math.round(metrics.customerConversionRate * 100) / 100,
      mrr_new: metrics.mrrNew,
      mrr_cumulative: metrics.mrrCumulative,
      outreach_sends_this_week: metrics.outreachSendsThisWeek,
      outreach_sends_target: OUTREACH_TARGET_PER_WEEK,
      outreach_on_track: metrics.outreachOnTrack,
      primary_bottleneck: metrics.primaryBottleneck,
      recommended_action: metrics.recommendedAction,
    },
    { onConflict: 'week_ending' }
  )

  if (error) throw error
}
