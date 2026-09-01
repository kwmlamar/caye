/**
 * Weekly mission outcomes computation
 * Reads funnel data, computes metrics, identifies bottlenecks
 * Integrates with existing job-search and outreach infrastructure
 *
 * GET /api/caye/missions/weekly-outcomes?week_ending=2026-08-31
 * POST /api/caye/missions/weekly-outcomes (recompute this week)
 */

import { NextRequest, NextResponse } from 'next/server'
import { computeEmploymentMissionOutcomes, storeEmploymentMissionMetrics } from '@/lib/mission-outcomes/compute-employment-mission'
import { computeRevenueMissionOutcomes, storeRevenueMissionMetrics } from '@/lib/mission-outcomes/compute-revenue-mission'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase configuration')
}

/**
 * GET: Fetch computed metrics for a specific week
 * Query: ?week_ending=2026-08-31
 */
export async function GET(request: NextRequest) {
  try {
    const weekEndingParam = request.nextUrl.searchParams.get('week_ending')

    if (!weekEndingParam) {
      return NextResponse.json(
        { error: 'Missing week_ending parameter (YYYY-MM-DD format)' },
        { status: 400 }
      )
    }

    const weekEnding = new Date(weekEndingParam)
    if (isNaN(weekEnding.getTime())) {
      return NextResponse.json(
        { error: 'Invalid week_ending format; use YYYY-MM-DD' },
        { status: 400 }
      )
    }

    // For now, return instruction message since metrics are computed on-demand
    return NextResponse.json({
      status: 'not_found',
      message: 'Weekly outcomes are computed on-demand. Use POST to compute for this week.',
      weekEnding: weekEnding.toISOString().split('T')[0],
    })
  } catch (error) {
    console.error('GET /api/caye/missions/weekly-outcomes error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST: Compute and store this week's mission outcomes
 * Runs employment + revenue mission computation in parallel
 */
export async function POST(request: NextRequest) {
  try {
    // Verify CRON_SECRET or founder auth
    const cronsecret = request.headers.get('x-cron-secret')
    const expectedSecret = process.env.CRON_SECRET

    if (!expectedSecret || cronsecret !== expectedSecret) {
      // Also check for founder auth header (not implemented yet, for future)
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Compute for this week (week ending Sunday)
    const today = new Date()
    const weekEnding = new Date(today)
    weekEnding.setDate(today.getDate() + (7 - today.getDay()))
    weekEnding.setHours(23, 59, 59, 999)

    console.log(`Computing mission outcomes for week ending ${weekEnding.toISOString().split('T')[0]}`)

    // Run both computations in parallel
    const [employmentMetrics, revenueMetrics] = await Promise.all([
      computeEmploymentMissionOutcomes(weekEnding, supabaseUrl, supabaseServiceKey),
      computeRevenueMissionOutcomes(weekEnding, supabaseUrl, supabaseServiceKey),
    ])

    // Store both
    await Promise.all([
      storeEmploymentMissionMetrics(employmentMetrics, supabaseUrl, supabaseServiceKey),
      storeRevenueMissionMetrics(revenueMetrics, supabaseUrl, supabaseServiceKey),
    ])

    // Return summary
    return NextResponse.json(
      {
        status: 'success',
        weekEnding: weekEnding.toISOString().split('T')[0],
        employment: {
          discovered: employmentMetrics.jobsDiscovered,
          qualified: employmentMetrics.jobsQualified,
          submitted: employmentMetrics.applicationsSubmitted,
          responses: employmentMetrics.responsesReceived,
          positiveResponses: employmentMetrics.positiveResponses,
          interviews: employmentMetrics.interviewsCompleted,
          offers: employmentMetrics.offersReceived,
          bottleneck: employmentMetrics.primaryBottleneck,
          recommendedAction: employmentMetrics.recommendedAction,
        },
        revenue: {
          discovered: revenueMetrics.prospectsDiscovered,
          contacted: revenueMetrics.contactsAttempted,
          replies: revenueMetrics.repliesReceived,
          positiveReplies: revenueMetrics.positiveReplies,
          demos: revenueMetrics.demosScheduled,
          customers: revenueMetrics.customersAcquired,
          mrrNew: revenueMetrics.mrrNew,
          mrrCumulative: revenueMetrics.mrrCumulative,
          outreachOnTrack: revenueMetrics.outreachOnTrack,
          bottleneck: revenueMetrics.primaryBottleneck,
          recommendedAction: revenueMetrics.recommendedAction,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('POST /api/caye/missions/weekly-outcomes error:', error)
    return NextResponse.json(
      {
        error: 'Computation failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
