---
status: open
created: 2026-05-28
trigger: switching Caye primary URL from current host to meetcaye.com
---

# Caye — Domain migration checklist

Both `meetcaye.com` and `getcaye.com` purchased 2026-05-28. Not yet primary. Use this file to track everything that needs to update before you flip the switch, plus everything that needs to be verified after.

The danger is silent failure — an OAuth callback URL that stops matching, a webhook that 404s, a cron job hitting a stale URL. Do not flip primary until every box below is checked.

## DNS + hosting

- [ ] Add `meetcaye.com` to Vercel project as a domain
- [ ] Add `getcaye.com` to Vercel project as a 301 redirect to `meetcaye.com`
- [ ] Update Namecheap nameservers or DNS records per Vercel's instructions
- [ ] Confirm HTTPS cert provisions on both
- [ ] Decide: bare `meetcaye.com` or `www.meetcaye.com` (recommended: bare)

## Environment variables

- [ ] `NEXT_PUBLIC_APP_URL` (or whatever the canonical env var is) updated in Vercel
- [ ] Any hardcoded URLs in code — grep for the current production hostname and replace
- [ ] Local `.env.local` updated if anything cares

## Meta app (Facebook Developers)

- [ ] App Domain updated to `meetcaye.com`
- [ ] OAuth redirect URIs updated (Facebook Login)
- [ ] Webhook callback URL updated (Messenger, Instagram, WhatsApp)
- [ ] Re-verify webhook subscription after URL change
- [ ] Privacy Policy and Terms URLs updated

## Zoho

- [ ] Zoho API console — OAuth redirect URI updated to `meetcaye.com`
- [ ] Re-test Zoho Mail connection on a workspace (full OAuth round trip)
- [ ] Re-test Zoho Calendar connection
- [ ] Confirm existing pilot workspaces (Bimini, Simply Dave) still have valid tokens — if redirect URI change invalidates them, plan a reconnect message

## Supabase

- [ ] Auth — Site URL updated
- [ ] Auth — Redirect URLs allowlist updated (include both meetcaye.com and getcaye.com so the redirect works either way during transition)
- [ ] Storage / Edge function URLs if any hardcoded

## Cron jobs / scheduled tasks

- [ ] Inventory current cron endpoints — list them here as you find them
- [ ] Update any external scheduler (Vercel Cron, Supabase scheduled functions, GitHub Actions, etc.) that hits a hostname
- [ ] Verify after switch — every cron's most recent run should succeed

## Email + outbound

- [ ] Booking confirmation email templates — any URLs pointing to the dashboard
- [ ] Owner-notification emails (the "Caye held this one" notifications)
- [ ] Any "click here to view in Caye" links in outbound copy
- [ ] Email "from" address if it's tied to a domain you're moving away from

## Third-party integrations

- [ ] Stripe (if connected) — return URLs, webhook URLs
- [ ] Any other OAuth providers — grep for `redirect_uri`

## In-product copy and brand

- [ ] Landing page footer (currently mentions "Nassau" — fine to leave, but if it links to old URL, fix)
- [ ] Privacy / Terms pages — any reference to current hostname
- [ ] Help docs (none yet, but flag for when they exist)

## Communication

- [ ] Heads-up to Karenda before she sees the URL change (avoids phishing concern)
- [ ] Heads-up to Simply Dave Tours if their workspace is active

## Post-switch verification (do all of these the day you flip)

- [ ] Sign up flow end-to-end on `meetcaye.com`
- [ ] Login flow
- [ ] Zoho OAuth connect a fresh test workspace
- [ ] Meta OAuth connect a fresh test workspace
- [ ] Receive a real test email — confirm the full pipeline still works (Gate 1/2/3, calendar conflict check, auto-confirm)
- [ ] Receive a real test WhatsApp DM
- [ ] Cron job that runs most frequently — confirm next run succeeds
- [ ] `getcaye.com` redirects to `meetcaye.com` (301, not 302)
- [ ] Old hostname either redirects to `meetcaye.com` or is fully retired

## Open questions

- Sunset `tropichat.chat` or keep redirecting? Decide before flip.
- Domain primary email — do you want `lamar@meetcaye.com`? If so, set up Zoho Mail hosting for the new domain before announcing.

## Meta Business Portfolio cleanup (deferred, NOT v1 blocker)

Current state (2026-05-28): The WABA holding Caye's WhatsApp number lives under the **Lamar Sineus** personal Meta Business Portfolio, not under **TropiTech Solutions** (which is set up but has 0 assets). This is fine for v1 — the portfolio layer is invisible to operators, and Meta asset transfers carry deployment risk during active reviews.

Defer this cleanup until:
- Caye is generating revenue
- There's a real reason to formalize the business asset hierarchy (employees with separate Meta access, billing requirements, compliance, etc.)
- No active reviews are in flight on the affected assets

When ready:
- [ ] Submit asset transfer request: WABA + phone number from Lamar Sineus portfolio → TropiTech Solutions portfolio
- [ ] Approve from both portfolio sides
- [ ] Verify display name, templates, and verification status survive the transfer (re-submit anything that resets)
- [ ] Update env vars if the WABA ID changes (it shouldn't, but verify)

## WhatsApp display name change — Tropichat → Caye (Edit currently locked, reason TBD)

Current state (2026-05-28): The WhatsApp display name is `Tropichat`. Status `Connected`. The Edit button in WhatsApp Manager → Phone Numbers shows the "not allowed" cursor when clicked. The reason for the lock is **not confirmed** — initially assumed to be a 30-day cooldown but the activity log shows no display-name-related events in the last ~36 days, so that theory is suspect.

**Diagnostic steps still TODO:**
- [ ] Hover the disabled Edit button — Meta usually shows a tooltip explaining why
- [ ] Check business verification status (separate from phone verification) — display name changes can be locked until the business itself is verified
- [ ] Check phone number quality rating (Green/Yellow/Red)
- [ ] Use Meta in-product support (`?` icon → Get support) to ask why the Edit is locked
- [ ] Filter activity log by something other than "Business profile" to surface any hidden display-name events

This does NOT block the WhatsApp messaging feature shipping. Operators will see `Tropichat` as the sender during dogfood and initial Karenda enable. The rename is a cosmetic switch with no code impact, whenever Meta unlocks it.

When the cooldown expires:
- [ ] Click Edit on the display name field in WhatsApp Manager → Phone Numbers
- [ ] Enter: `Caye`
- [ ] Justification: *"Caye is the name of our AI receptionist product, which our customers know us by. We're aligning the WhatsApp identity to match the product name. Live at meetcaye.com."*
- [ ] Evidence: meetcaye.com screenshot, persona doc reference
- [ ] Submit → wait 1-3 business days for Meta approval
- [ ] No code or env var changes after approval — display name swaps silently

Briefing for Karenda on her next call: *"You'll see the WhatsApp sender as 'Tropichat' for now — that's our platform's name. Renaming it to 'Caye' in a few weeks. Same product, same Caye, just changing the label."*
