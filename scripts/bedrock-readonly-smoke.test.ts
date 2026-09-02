import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const runner = resolve(process.cwd(), 'scripts/bedrock-readonly-smoke.mjs')
const source = readFileSync(runner, 'utf8')

describe('Bedrock read-only smoke runner', () => {
  it('executes dry-run JSON without making Bedrock queries or printing the credential', () => {
    const secret = 'definitely-not-for-output'
    const stdout = execFileSync(
      process.execPath,
      ['--conditions=react-server', '--experimental-transform-types', runner, '--workspace', 'ws-smoke', '--dry-run', '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          BEDROCK_COMPANY_ID: 'company-smoke',
          BEDROCK_SUPABASE_URL: 'https://example.invalid',
          BEDROCK_CREDENTIAL_REF: 'smoke_test',
          DOMAIN_SECRET_SMOKE_TEST: secret,
        },
      },
    )

    const result = JSON.parse(stdout)
    expect(result).toMatchObject({ workspaceId: 'ws-smoke', companyId: 'company-smoke', dryRun: true })
    expect(result.queryEvidence.length).toBeGreaterThan(0)
    expect(stdout).not.toContain(secret)
  })

  it('contains no mutation, RPC, polling, or sync activation calls', () => {
    const forbidden = [
      /\.insert\s*\(/,
      /\.update\s*\(/,
      /\.upsert\s*\(/,
      /\.delete\s*\(/,
      /\.rpc\s*\(/,
      /setInterval\s*\(/,
      /setTimeout\s*\(/,
      /startPolling\s*\(/i,
      /syncDomain/i,
      /domainSync/i,
    ]

    for (const pattern of forbidden) expect(source).not.toMatch(pattern)
  })
})
