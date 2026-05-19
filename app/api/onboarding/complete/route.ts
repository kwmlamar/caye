import { NextRequest, NextResponse } from 'next/server'
import { buildBusinessProfile, saveBusinessProfile } from '@/lib/onboarding'
import { createServiceClient } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { workspaceId, answers, businessName } = body as {
      workspaceId: string
      answers: Record<string, string>
      businessName: string
    }

    if (!workspaceId || !answers) {
      return NextResponse.json({ error: 'Missing workspaceId or answers' }, { status: 400 })
    }

    // Verify workspaceId exists
    const supabase = createServiceClient()
    const { data: customer, error: customerErr } = await supabase
      .from('customers')
      .select('id, business_name')
      .eq('id', workspaceId)
      .single()

    if (customerErr || !customer) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }

    const name = businessName || customer.business_name || 'your business'
    const profile = await buildBusinessProfile(answers, name)
    const { error: saveErr } = await saveBusinessProfile(workspaceId, profile, answers)

    if (saveErr) {
      return NextResponse.json({ error: saveErr }, { status: 500 })
    }

    return NextResponse.json({ profile })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected error'
    console.error('[onboarding/complete]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
