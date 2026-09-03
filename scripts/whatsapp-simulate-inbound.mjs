#!/usr/bin/env node
/**
 * whatsapp:simulate — build and (optionally) send a fake Meta Cloud API
 * "inbound message" webhook payload to Caye's operator WhatsApp webhook
 * (app/api/webhooks/whatsapp-operator/route.ts), so a developer can exercise
 * that code path locally without a real Meta WhatsApp account.
 *
 * HONESTY NOTE — read before you rely on this:
 *   The webhook route returns HTTP 200 immediately and does the real work
 *   (`processInbound`) inside `after(...)`, off the response path. A 200 from
 *   this tool ONLY means the route accepted the payload (parsed the JSON and,
 *   if META_APP_SECRET is set, verified the signature). It is NOT proof that
 *   Caye replied, or even that processing succeeded. Real processing needs a
 *   working Supabase connection and an LLM provider key; with no `.env` file
 *   present, the background handler in `after()` will fail (you'll only see
 *   that failure in the dev server's own console, not in this tool's output,
 *   and not in the HTTP response either).
 *
 * Usage:
 *   node scripts/whatsapp-simulate-inbound.mjs --text "hey caye" [options]
 *
 * Options:
 *   --text <string>            Required. The inbound message body.
 *   --from <E.164>              Sender phone number. Default: a clearly fake
 *                                test number (+15550001234).
 *   --name <string>              WhatsApp profile display name for the sender.
 *                                Default: "Test Operator".
 *   --phone-number-id <id>      Meta phone_number_id in the payload metadata.
 *                                Default: "000000000000000" (fake).
 *   --waba-id <id>               WhatsApp Business Account id (entry.id).
 *                                Default: "000000000000001" (fake).
 *   --url <url>                  Target webhook URL.
 *                                Default: http://localhost:3000/api/webhooks/whatsapp-operator
 *   --allow-remote                Required opt-out to target any host other
 *                                than localhost/127.0.0.1. Even then, a host
 *                                containing meetcaye.com or getcaye.com is
 *                                refused unconditionally — those are
 *                                production and this tool must never be
 *                                pointed at them.
 *   --print-only                  Build and print the payload + headers,
 *                                send nothing.
 *   -h, --help                    Print this help and exit.
 *
 * Signing: if META_APP_SECRET is present in the environment, this script
 * signs the raw JSON body with HMAC-SHA256 exactly the way the route's own
 * verifySignature() does (`sha256=` + hex digest) and sends it as the
 * `x-hub-signature-256` header. If META_APP_SECRET is unset, no signature
 * header is sent — which is fine, because the route only checks the
 * signature `if (secret)` is set server-side too.
 */

import { createHmac } from 'node:crypto'

// ─── Pure functions (unit-tested in whatsapp-simulate-inbound.test.ts) ─────

/**
 * Build a Meta Cloud API-shaped inbound-message webhook payload.
 *
 * Shape matches what app/api/webhooks/whatsapp-operator/route.ts's
 * processInbound() reads:
 *   payload.entry[0].changes[0].value.messages[0]   -> the WaInboundMessage
 *   payload.entry[0].changes[0].value.metadata       -> { phone_number_id }
 *   payload.entry[0].changes[0].value.contacts[0]    -> { wa_id, profile.name }
 *   payload.entry[0].id                              -> the WABA id
 */
export function buildInboundPayload({
  text,
  from,
  name = 'Test Operator',
  phoneNumberId = '000000000000000',
  wabaId = '000000000000001',
  messageId,
  timestamp,
}) {
  if (!text || typeof text !== 'string') {
    throw new Error('buildInboundPayload: --text is required and must be a non-empty string')
  }
  if (!from || typeof from !== 'string') {
    throw new Error('buildInboundPayload: --from is required and must be a non-empty string')
  }

  const id = messageId ?? `wamid.SIMULATED_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000))

  // Meta sends `from` and `wa_id` without a leading "+".
  const bareFrom = from.replace(/^\+/, '')

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: phoneNumberId,
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  profile: { name },
                  wa_id: bareFrom,
                },
              ],
              messages: [
                {
                  id,
                  from: bareFrom,
                  timestamp: ts,
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  }
}

/**
 * Recompute the exact signature scheme used by verifySignature() in
 * app/api/webhooks/whatsapp-operator/route.ts:
 *   `sha256=` + HMAC-SHA256(rawBody, secret) as lowercase hex.
 */
export function signBody(rawBody, secret) {
  if (!secret) return null
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}

/**
 * Safety guard: only allow sending to localhost/127.0.0.1 by default.
 * A non-local host requires allowRemote=true, and hosts containing
 * meetcaye.com or getcaye.com (production) are refused unconditionally,
 * regardless of allowRemote.
 *
 * Returns { allowed: true } or { allowed: false, reason: string }.
 * Never throws — the CLI wrapper decides how to report/exit.
 */
export function checkTargetAllowed(urlString, { allowRemote = false } = {}) {
  let url
  try {
    url = new URL(urlString)
  } catch {
    return { allowed: false, reason: `--url is not a valid URL: ${urlString}` }
  }

  const host = url.hostname.toLowerCase()

  // Production hosts are refused outright — no flag can override this.
  if (host.includes('meetcaye.com') || host.includes('getcaye.com')) {
    return {
      allowed: false,
      reason: `Refusing to send: "${host}" looks like a Caye production host. This tool must never be pointed at production, and --allow-remote cannot override that.`,
    }
  }

  const isLocal = host === 'localhost' || host === '127.0.0.1'
  if (isLocal) return { allowed: true }

  if (!allowRemote) {
    return {
      allowed: false,
      reason: `Refusing to send to non-local host "${host}" without --allow-remote. This tool defaults to localhost-only to avoid accidentally hitting a shared or remote environment.`,
    }
  }

  return { allowed: true }
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    text: undefined,
    from: '+15550001234',
    name: 'Test Operator',
    phoneNumberId: '000000000000000',
    wabaId: '000000000000001',
    url: 'http://localhost:3000/api/webhooks/whatsapp-operator',
    printOnly: false,
    allowRemote: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--text':
        args.text = argv[++i]
        break
      case '--from':
        args.from = argv[++i]
        break
      case '--name':
        args.name = argv[++i]
        break
      case '--phone-number-id':
        args.phoneNumberId = argv[++i]
        break
      case '--waba-id':
        args.wabaId = argv[++i]
        break
      case '--url':
        args.url = argv[++i]
        break
      case '--print-only':
        args.printOnly = true
        break
      case '--allow-remote':
        args.allowRemote = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function printHelp() {
  console.log(`
whatsapp:simulate — simulate an inbound WhatsApp message to Caye's operator webhook.

  node scripts/whatsapp-simulate-inbound.mjs --text "hey caye" [options]

Options:
  --text <string>          Required. The inbound message body.
  --from <E.164>            Sender phone number. Default: +15550001234 (fake).
  --name <string>            WhatsApp profile name. Default: "Test Operator".
  --phone-number-id <id>    Meta phone_number_id. Default: fake id.
  --waba-id <id>             WhatsApp Business Account id. Default: fake id.
  --url <url>                Target webhook URL.
                             Default: http://localhost:3000/api/webhooks/whatsapp-operator
  --allow-remote              Required to target a non-localhost host. Even
                             with this flag, meetcaye.com / getcaye.com
                             (production) are always refused.
  --print-only                Build and print the payload + signature, send
                             nothing.
  -h, --help                  Show this help.

NOTE: a 200 response only means the webhook accepted the payload. Real
processing happens in the route's after() background handler and needs
Supabase plus an LLM key — with no .env file, that background handler will
fail. That is expected, not a bug in this tool.
`)
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exitCode = 1
    return
  }

  if (args.help) {
    printHelp()
    return
  }

  if (!args.text) {
    console.error('Error: --text is required (the inbound message body).')
    console.error('Run with --help for usage.')
    process.exitCode = 1
    return
  }

  const payload = buildInboundPayload({
    text: args.text,
    from: args.from,
    name: args.name,
    phoneNumberId: args.phoneNumberId,
    wabaId: args.wabaId,
  })
  const rawBody = JSON.stringify(payload)

  const secret = process.env.META_APP_SECRET
  const signature = signBody(rawBody, secret)

  const headers = { 'Content-Type': 'application/json' }
  if (signature) headers['x-hub-signature-256'] = signature

  console.log('── Payload ──────────────────────────────────────────────')
  console.log(JSON.stringify(payload, null, 2))
  console.log('── Headers ───────────────────────────────────────────────')
  console.log(JSON.stringify(headers, null, 2))
  if (!secret) {
    console.log(
      '(META_APP_SECRET not set in this environment — no x-hub-signature-256 header sent. ' +
        'The route skips signature verification entirely when its own META_APP_SECRET is unset, so this is expected for local testing.)'
    )
  }

  if (args.printOnly) {
    console.log('\n--print-only set — not sending anything.')
    return
  }

  const guard = checkTargetAllowed(args.url, { allowRemote: args.allowRemote })
  if (!guard.allowed) {
    console.error(`\nRefusing to send: ${guard.reason}`)
    process.exitCode = 1
    return
  }

  console.log(`\n── Sending to ${args.url} ──────────────────────────────`)
  let response
  try {
    response = await fetch(args.url, { method: 'POST', headers, body: rawBody })
  } catch (err) {
    console.error(`Request failed: ${err.message}`)
    process.exitCode = 1
    return
  }

  const responseText = await response.text()
  console.log(`Status: ${response.status} ${response.statusText}`)
  console.log('Response body:')
  console.log(responseText)
  console.log(
    '\nReminder: this 200 only means the webhook accepted the payload. Real ' +
      'processing runs in after() and needs Supabase + an LLM key — check the ' +
      "dev server's own console output for what actually happened, not this response."
  )

  if (!response.ok) process.exitCode = 1
}

// Only run the CLI when this file is executed directly (not when imported
// for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
