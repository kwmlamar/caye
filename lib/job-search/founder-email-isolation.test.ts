import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('founder job-search email isolation', () => {
  const migration = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '20260829c_founder_job_search_email.sql'),
    'utf8',
  )
  const callback = readFileSync(
    join(__dirname, '..', '..', 'app', 'api', 'auth', 'zoho', 'callback', 'route.ts'),
    'utf8',
  )

  it('stores founder grants outside connected_accounts with RLS enabled', () => {
    expect(migration).toContain('create table if not exists public.founder_connected_accounts')
    expect(migration).toContain('alter table public.founder_connected_accounts enable row level security')
    expect(migration).not.toMatch(/alter table public\.connected_accounts/)
  })

  it('returns before customer discovery and announcements', () => {
    const founderBranch = callback.indexOf('if (isFounderJobSearch)')
    const isolatedReturn = callback.indexOf("return NextResponse.redirect(ok('job_search_zoho_connected=1'))")
    const announcement = callback.indexOf('announceConnection')
    expect(founderBranch).toBeGreaterThan(-1)
    expect(isolatedReturn).toBeGreaterThan(founderBranch)
    expect(announcement).toBeGreaterThan(isolatedReturn)
  })
})
