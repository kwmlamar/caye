/**
 * CLI wrapper for ad-hoc manual sourcing runs — the actual logic lives in
 * lib/outreach-sourcing.ts (extracted 2026-08-12 so
 * app/api/caye/outreach-sourcing-scan can call it on a schedule).
 *
 * Usage (dotenv isn't installed in this repo — source env vars directly):
 *   set -a && source .env.local && set +a && npx tsx scripts/source-leads.ts "<query>" "<location>" [maxResults]
 *
 * Example:
 *   npx tsx scripts/source-leads.ts "boat tour" "Cartagena, Colombia" 20
 *
 * Prints progress to stderr, and the final JSON array of leads to stdout
 * (so `> leads.json` redirection captures clean data without the log noise).
 */
import { sourceLeads } from '../lib/outreach-sourcing'

async function main() {
  const [query, location, maxArg] = process.argv.slice(2)
  if (!query || !location) {
    console.error('Usage: npx tsx scripts/source-leads.ts "<query>" "<location>" [maxResults]')
    process.exit(1)
  }
  const maxResults = maxArg ? parseInt(maxArg, 10) : 20

  console.error(`Searching Places API: "${query}" in "${location}"...`)
  const leads = await sourceLeads(query, location, maxResults)

  const withEmail = leads.filter((l) => l.email)
  console.error(`\nDone: ${leads.length} businesses processed, ${withEmail.length} with a found email.`)
  console.log(JSON.stringify(leads, null, 2))
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
