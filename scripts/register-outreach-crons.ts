/**
 * One-time registration of the two new autonomous-outreach cron endpoints
 * on cron-job.org (decisions-log 2026-08-12), using the console.cron-
 * job.org REST API v1 (CRON_JOB_ORG_API_KEY) instead of the manual
 * dashboard registration every prior cron in this repo used — the first
 * script in this repo to do so.
 *
 * Usage:
 *   set -a && source .env.local && set +a && npx tsx scripts/register-outreach-crons.ts
 *
 * Requires NEXT_PUBLIC_APP_URL (or pass a base URL as argv[2]) to point at
 * the deployed production URL, not localhost — cron-job.org has to be able
 * to reach it.
 */

const API_KEY = process.env.CRON_JOB_ORG_API_KEY
const CRON_SECRET = process.env.CRON_SECRET
if (!API_KEY) {
  console.error('CRON_JOB_ORG_API_KEY not set — source .env.local first')
  process.exit(1)
}
if (!CRON_SECRET) {
  console.error('CRON_SECRET not set — the registered jobs need it as x-cron-secret')
  process.exit(1)
}

const baseUrl = process.argv[2] || process.env.NEXT_PUBLIC_APP_URL
if (!baseUrl || baseUrl.includes('localhost')) {
  console.error('Pass the deployed base URL as an argument, or set NEXT_PUBLIC_APP_URL to it — got: ' + baseUrl)
  process.exit(1)
}

const API_BASE = 'https://api.cron-job.org'

interface CronJobSchedule {
  timezone: string
  hours: number[]
  mdays: number[]
  minutes: number[]
  months: number[]
  wdays: number[]
}

interface JobDef {
  title: string
  path: string
  schedule: CronJobSchedule
}

// -1 in any position means "every value" for that field, per cron-job.org's
// documented schedule shape.
const EVERY = [-1]

const JOBS: JobDef[] = [
  {
    title: 'Caye — outreach sourcing scan',
    path: '/api/caye/outreach-sourcing-scan',
    // Daily, 09:00 UTC.
    schedule: { timezone: 'UTC', hours: [9], mdays: EVERY, minutes: [0], months: EVERY, wdays: EVERY },
  },
  {
    title: 'Caye — outreach autosend scan',
    path: '/api/caye/outreach-autosend-scan',
    // Hourly, on the hour — matches the cadence the outreach-nudge-scan it
    // replaced was registered at.
    schedule: { timezone: 'UTC', hours: EVERY, mdays: EVERY, minutes: [0], months: EVERY, wdays: EVERY },
  },
]

async function createJob(job: JobDef): Promise<void> {
  const url = `${baseUrl}${job.path}`
  const res = await fetch(`${API_BASE}/jobs`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      job: {
        url,
        enabled: true,
        title: job.title,
        saveResponses: true,
        requestMethod: 0, // GET
        schedule: job.schedule,
        extendedData: {
          headers: { 'x-cron-secret': CRON_SECRET },
        },
      },
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    console.error(`FAILED to create "${job.title}" (HTTP ${res.status}): ${text}`)
    return
  }

  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = text }
  console.log(`Created "${job.title}" → ${url}`)
  console.log(JSON.stringify(parsed, null, 2))
}

async function main() {
  console.log(`Registering against base URL: ${baseUrl}\n`)
  for (const job of JOBS) {
    await createJob(job)
  }
  console.log('\nDone. Verify in the cron-job.org dashboard — this script does not confirm the job actually ticks, only that creation succeeded.')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
