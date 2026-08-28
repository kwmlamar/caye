import { createHash } from 'node:crypto'
import type { BenchActor, BenchEffect, BenchEvidence, BenchInputEvent } from '../types'
import type { Booking } from '../production-state'
import { REPLAY_TRACE_SCHEMA_VERSION, type RawTraceInput, type ReplaySeed, type ReplayTrace } from './types'

/**
 * replay/sanitize.ts — the production-export safety boundary.
 *
 * This PR does not ship a script that reads real production tables — no
 * Supabase access, no live customer data, per the task's own instruction
 * to build "the versioned replay format + safe importer + representative
 * sanitized fixtures first" and document the production-export follow-up
 * (see this file's final section). What it DOES ship is the boundary a
 * future export script must pass every raw record through before it can
 * become a `ReplayTrace`: `sanitizeRawTrace` is a pure function from an
 * explicit, versioned `RawTraceInput` (whatever a hypothetical export
 * pulls from `unified_messages` / `unified_conversations` / `bookings` /
 * `operator_allowlist` / `owner_attention`) to the trace format Caye Bench
 * v2 actually runs — never a passthrough, never "just JSON.stringify the
 * row and hope for the best."
 *
 * Two independent redaction passes, deliberately overlapping:
 *   1. STRUCTURAL — every actor identity (`RawActorInput.rawId`, plus
 *      name/email/phone) is replaced with a stable pseudonym derived from
 *      a per-export salt; the raw values are never copied into the
 *      output, only hashed. Two different raw ids always produce
 *      different pseudonyms; the SAME raw id always produces the SAME
 *      pseudonym within one sanitize call, so a real customer's identity
 *      stays consistent across a trace without ever appearing in it.
 *   2. FREE-TEXT — `redactPII` regex-scrubs emails/phone numbers out of
 *      every event's `text`, plus a name-pass over any known display
 *      names supplied on `RawActorInput` (customer message bodies
 *      routinely restate a name/number even when the structured fields
 *      are already clean).
 *
 * Neither pass is a guarantee of perfect anonymization — a sufficiently
 * distinctive incident description could still be identifiable from
 * context even with names/emails/phones stripped. `sourceDescription`
 * and `incidentRefs` are the only fields a human author writes free-form,
 * so keep them to the shape of the FAILURE MODE ("draft-in-inbox timeout
 * during a payment-confirmation exchange"), not a specific person's
 * story — the same convention `lib/caye-agent/replay/fixtures/*.ts`
 * already follows for its own historical-incident fixtures.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PHONE_RE = /\+?\d[\d\-\s().]{7,}\d/g

export function redactPII(text: string, knownNames: readonly string[] = []): string {
  let out = text.replace(EMAIL_RE, '[redacted-email]').replace(PHONE_RE, '[redacted-phone]')
  for (const rawName of knownNames) {
    const name = rawName.trim()
    if (!name) continue
    for (const part of name.split(/\s+/)) {
      if (part.length < 2) continue
      const re = new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
      out = out.replace(re, '[redacted-name]')
    }
  }
  return out
}

function pseudonymize(rawId: string, role: string, salt: string): string {
  const hash = createHash('sha256').update(`${salt}:${role}:${rawId}`).digest('hex').slice(0, 10)
  return `${role}_${hash}`
}

function redactDataFields(data: Record<string, unknown>, knownNames: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    out[key] = typeof value === 'string' ? redactPII(value, knownNames) : value
  }
  return out
}

function sanitizeEvidence(evidence: BenchEvidence[] | undefined, knownNames: readonly string[]): BenchEvidence[] | undefined {
  return evidence?.map((e) => ({ ...e, summary: e.summary ? redactPII(e.summary, knownNames) : e.summary }))
}

function sanitizeEffect(effect: BenchEffect, knownNames: readonly string[], workspaceId: string): BenchEffect {
  return {
    ...effect,
    // Historical effects are authored against a raw/placeholder workspace
    // id (there's no per-actor identity to individually pseudonymize
    // here, just one workspace) — always remapped to the SAME
    // pseudonymized workspace id the rest of the trace uses, otherwise
    // every historical effect would spuriously fail the
    // cross_workspace_leakage check against `trace.workspaceId`.
    workspaceId,
    claim: effect.claim ? redactPII(effect.claim, knownNames) : effect.claim,
    evidence: sanitizeEvidence(effect.evidence, knownNames),
    metadata: effect.metadata ? redactDataFields(effect.metadata, knownNames) : effect.metadata,
  }
}

export interface SanitizeOptions {
  /** Per-export secret. MUST be random and kept out of the output trace —
   *  a pseudonym derived from a guessable/reused salt can be reversed by
   *  re-hashing candidate raw ids. Rotate it per export batch; never
   *  derive it from the raw ids themselves. */
  salt: string
  traceId: string
  sanitizedAt?: string
}

export function sanitizeRawTrace(raw: RawTraceInput, opts: SanitizeOptions): ReplayTrace {
  if (!opts.salt || opts.salt.length < 8) {
    throw new Error('sanitizeRawTrace: opts.salt must be a real per-export secret (>= 8 chars), not a placeholder.')
  }

  const workspaceId = pseudonymize(raw.workspaceRawId, 'ws', opts.salt)
  const actorIdMap = new Map<string, string>()
  const actorByRawId = new Map<string, BenchActor>()
  const knownNames: string[] = []
  const actors: BenchActor[] = raw.actors.map((a, i) => {
    const pseudo = pseudonymize(a.rawId, a.role, opts.salt)
    actorIdMap.set(a.rawId, pseudo)
    if (a.displayName) knownNames.push(a.displayName)
    if (a.email) knownNames.push(a.email)
    if (a.phone) knownNames.push(a.phone)
    const actor: BenchActor = { id: pseudo, role: a.role, name: `${a.role[0].toUpperCase()}${a.role.slice(1)} ${i + 1}` }
    actorByRawId.set(a.rawId, actor)
    return actor
  })

  function mapActor(rawId: string): string {
    const mapped = actorIdMap.get(rawId)
    if (!mapped) throw new Error(`sanitizeRawTrace: event/seed references unknown actor "${rawId}" — add it to raw.actors first.`)
    return mapped
  }

  const events: BenchInputEvent[] = raw.events.map((e) => {
    const actor = actorByRawId.get(e.actorRawId)
    if (!actor) throw new Error(`sanitizeRawTrace: event "${e.id}" references unknown actor "${e.actorRawId}" — add it to raw.actors first.`)
    return {
      id: e.id,
      at: e.at,
      channel: e.channel,
      actor,
      kind: e.kind,
      text: e.text != null ? redactPII(e.text, knownNames) : undefined,
      data: e.data ? redactDataFields(e.data, knownNames) : undefined,
    }
  })

  const seed: ReplaySeed = {
    bookings: raw.seed?.bookings?.map(
      (b): Booking => ({
        ...b,
        customerId: actorIdMap.has(b.customerId) ? mapActor(b.customerId) : b.customerId,
        customerName: redactPII(b.customerName, knownNames),
      })
    ),
    businessFacts: raw.seed?.businessFacts
      ? Object.fromEntries(Object.entries(raw.seed.businessFacts).map(([k, v]) => [k, redactPII(v, knownNames)]))
      : undefined,
    artifacts: raw.seed?.artifacts?.map((a) => ({ ...a, caption: redactPII(a.caption, knownNames) })),
    attentionItems: raw.seed?.attentionItems?.map((item) => ({
      ...item,
      workspace_id: workspaceId,
      title: redactPII(item.title, knownNames),
      last_notified_summary: item.last_notified_summary ? redactPII(item.last_notified_summary, knownNames) : item.last_notified_summary,
      operator_aware_summary: item.operator_aware_summary ? redactPII(item.operator_aware_summary, knownNames) : item.operator_aware_summary,
    })),
    // No PII risk here (operation names + a closed outcome enum) — copied
    // through verbatim, but still explicit rather than a `...raw.seed`
    // spread so every ReplaySeed field is deliberately handled once, not
    // silently passed through.
    forcedProviderOutcomes: raw.seed?.forcedProviderOutcomes,
  }

  const historicalEffects = raw.historicalEffects.map((eff) => sanitizeEffect(eff, knownNames, workspaceId))

  return {
    schemaVersion: REPLAY_TRACE_SCHEMA_VERSION,
    traceId: opts.traceId,
    workspaceId,
    sourceDescription: raw.sourceDescription,
    incidentRefs: raw.incidentRefs,
    sanitizedAt: opts.sanitizedAt ?? new Date().toISOString(),
    startTime: raw.startTime,
    timezone: raw.timezone,
    businessName: raw.businessName,
    actors,
    events,
    seed,
    historicalEffects,
    provenance: { ...raw.provenance, redactionMethod: 'stable-pseudonym-sha256+pii-regex-v1' },
  }
}

// ---------------------------------------------------------------------------
// PRODUCTION-EXPORT FOLLOW-UP (documented, not built here)
//
// A real export script would live outside lib/caye-bench (it needs
// Supabase read access this repo's normal CI/test path must never have)
// and would:
//   1. Query unified_conversations/unified_messages, caye_operator_messages,
//      caye_tool_calls, bookings, business_facts (or the Zoho-canonical
//      calendar), business_artifacts, and owner_attention for one
//      workspace + time window.
//   2. Assemble a RawTraceInput from those rows — NOT a raw table dump;
//      the export script's job is to already know which columns matter
//      (this file's RawTraceInput shape is the contract it must produce).
//   3. Call sanitizeRawTrace with a freshly-generated, single-use salt
//      that is logged nowhere durable and discarded after the export run.
//   4. Write the result through parseReplayTrace (replay/trace-io.ts)
//      before saving, so a malformed export fails loudly instead of
//      silently producing an unusable fixture.
// This intentionally requires a human (or a reviewed, access-scoped job)
// with real production credentials to run it — those credentials must
// never be something a normal Caye Bench contributor or CI run has.
// ---------------------------------------------------------------------------
