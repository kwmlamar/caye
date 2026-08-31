import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const migrationsDir = join(process.cwd(), 'supabase', 'migrations')

function read(name: string): string {
  return readFileSync(join(migrationsDir, name), 'utf8')
}

function assertLooksLikeSql(filename: string, sql: string): void {
  const text = sql.trim()
  expect(text.length, `${filename} must not be empty`).toBeGreaterThan(0)
  expect(text, `${filename} contains TypeScript import/export`).not.toMatch(/^\s*(import|export)\s/m)
  expect(text, `${filename} contains a GitHub Actions/YAML document`).not.toMatch(/^\s*(name|on|jobs|permissions):\s/m)
  expect(text, `${filename} contains TypeScript type syntax`).not.toMatch(/^\s*(type|interface)\s+[A-Za-z_$]/m)
  expect(
    /\b(create|alter|drop|insert|update|delete|select|grant|revoke|comment|do|begin)\b/i.test(text),
    `${filename} must contain an SQL statement`
  ).toBe(true)
}

describe('SQL migration content contract', () => {
  it('rejects TypeScript/YAML masquerading as .sql across the migration directory', () => {
    const sqlFiles = readdirSync(migrationsDir).filter(name => name.endsWith('.sql'))
    expect(sqlFiles.length).toBeGreaterThan(0)
    for (const filename of sqlFiles) assertLooksLikeSql(filename, read(filename))
  })

  it('defines the durable canonical effect-verification substrate', () => {
    const sql = read('20260830_effect_verification_runtime_truth.sql')
    assertLooksLikeSql('20260830_effect_verification_runtime_truth.sql', sql)
    expect(sql).toMatch(/create table if not exists public\.caye_effect_verifications/i)
    expect(sql).toMatch(/verification_status\s+text\s+not null/i)
    expect(sql).toContain("'VERIFIED','PARTIAL','FAILED','INDETERMINATE'")
    expect(sql).toMatch(/VERIFIED requires independent post-execution observation evidence/i)
    expect(sql).toMatch(/unique \(workspace_id, idempotency_key\)/i)
    expect(sql).toMatch(/retry_safe boolean not null default false/i)
    expect(sql).toMatch(/recovery_state text not null default 'none'/i)
  })
})
