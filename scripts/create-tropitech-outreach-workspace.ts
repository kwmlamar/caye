/**
 * One-off: create TropiTech's own internal-use workspace (hello@getcaye.com
 * cold-outreach inbox) directly, skipping the WhatsApp cold-start signup
 * flow — Lamar (founder) is the sole operator, and the discovery interview
 * that flow exists to run doesn't apply here (see
 * scripts/seed-tropitech-sales-workspace.ts's docstring, issue #66).
 *
 * Mirrors the customers-row shape of tryColdStartWorkspace()
 * (lib/onboarding-whatsapp.ts) so this workspace looks identical to any
 * other on that table. Deliberately does NOT insert an operator_allowlist
 * 'owner' row — the existing ensure_founder_in_allowlist DB trigger
 * (supabase/migrations/20260624_operator_allowlist.sql) already adds
 * Lamar's founder_phone with role='founder', verified immediately, on
 * every new customers row. That's the whole "founder account is over it"
 * requirement — nothing else to wire.
 *
 * Run with (dotenv isn't installed in this repo — source env vars directly):
 *   set -a && source .env.local && set +a && npx tsx scripts/create-tropitech-outreach-workspace.ts
 * Then: npx tsx scripts/seed-tropitech-sales-workspace.ts <printed workspace id>
 */

import { createClient } from '@supabase/supabase-js'

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: created, error } = await supabase
    .from('customers')
    .insert({
      business_name: 'TropiTech Outreach',
      contact_email: 'hello@getcaye.com',
      full_name: 'Lamar',
      plan: 'free',
      status: 'trial',
    })
    .select('id, business_name')
    .single()

  if (error || !created) {
    console.error('Workspace creation failed:', error?.message ?? '(no row returned)')
    process.exit(1)
  }

  console.log(`Created workspace "${created.business_name}" — id: ${created.id}`)

  const { data: founderRow } = await supabase
    .from('operator_allowlist')
    .select('phone, role, verified_at')
    .eq('workspace_id', created.id)
    .eq('role', 'founder')
    .maybeSingle()

  if (founderRow) {
    console.log(`  Founder auto-added to operator_allowlist: ${founderRow.phone} (verified_at=${founderRow.verified_at})`)
  } else {
    console.warn('  WARNING: no founder row found in operator_allowlist — check platform_settings.founder_phone is set.')
  }

  console.log(`\nNext: npx tsx scripts/seed-tropitech-sales-workspace.ts ${created.id}`)
}

main()
