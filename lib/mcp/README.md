# Caye MCP adapter

Caye exposes its founder read capability layer over a stateless MCP `2026-07-28` endpoint at `/api/mcp`.

The MCP layer is transport only. It does not query Supabase directly and does not own business semantics. Tools map into the existing founder capability gateway, which owns scope and result truth.

## Authentication

Set these server-only environment variables:

- `CAYE_MCP_FOUNDER_TOKEN`: a long random bearer token used only by trusted server-to-server clients.
- `CAYE_MCP_FOUNDER_USER_ID`: the founder Supabase auth user id that this token maps to.

The bearer path remains available for trusted server-to-server clients. It is not used by ChatGPT, must never appear in a browser-visible variable, OAuth client field, MCP response, or documentation example, and must never be committed.

ChatGPT uses Caye's existing Supabase Auth project as the OAuth 2.1/OIDC authorization server. OAuth access tokens are validated by Supabase on Caye's server, then map to a founder only after Caye's server-side founder allowlist check. The caller cannot supply a founder UUID or workspace authority.

OAuth resource discovery is published at:

- `https://www.meetcaye.com/.well-known/oauth-protected-resource/api/mcp`

It advertises the Supabase OAuth authority and `offline_access`; Supabase owns the authorization code + PKCE, token, and refresh-token flows. Do not add an application token issuer or duplicate gateway authorization in OAuth code.

## One-time Supabase OAuth configuration

Before connecting ChatGPT in production, a Supabase project administrator must:

1. In **Authentication → OAuth Server**, enable the OAuth 2.1 server.
2. Set **Authorization Path** to `/oauth/consent`. Caye serves that consent page and it preserves the normal Caye sign-in flow.
3. Enable **Dynamic Client Registration** so ChatGPT can register its OAuth client during MCP setup. Review registered clients and require the consent screen for each grant.
4. Use an asymmetric JWT signing key (RS256 or ES256) before enabling OIDC `openid` flows.
5. Confirm the Supabase discovery document at `https://<project-ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1` advertises the authorization endpoint, token endpoint, dynamic registration endpoint, and `offline_access` scope.

No database migration or new Caye secret is required. `NEXT_PUBLIC_APP_URL` must be the deployed HTTPS Caye origin (normally `https://www.meetcaye.com`); it is used only to advertise the public MCP resource URL.

## ChatGPT custom MCP setup

After the production deployment and Supabase configuration above:

1. In ChatGPT, enable Developer Mode if your plan/workspace requires it, then open **Settings or Workspace settings → Apps → Create**.
2. Enter `https://www.meetcaye.com/api/mcp` as the MCP server URL.
3. Choose **OAuth**. Do not choose **No Auth** or paste `CAYE_MCP_FOUNDER_TOKEN` anywhere.
4. Select **Scan tools**. ChatGPT follows the protected-resource metadata to Supabase, registers a client, and opens Caye's `/oauth/consent` page.
5. Sign in as a Caye founder and approve the explicitly shown read-only request. A non-founder account is denied; a valid OAuth token alone does not grant founder authority.
6. Confirm the scan exposes exactly `caye_context_snapshot`, `caye_goals_list`, `caye_attention_list`, `caye_engineering_artifacts_list`, `caye_property_list`, and `caye_property_snapshot`, then create/publish the app according to your ChatGPT workspace policy.
7. In a fresh ChatGPT conversation, enable the app and call `caye_goals_list`. Supabase refresh tokens keep the connection valid after short-lived access tokens expire. For property questions, call `caye_property_list` first — a fresh session has no other way to learn a valid property id — then pass the `id` it returns to `caye_property_snapshot`.

## Server-to-server client connection

Configure a compatible remote MCP client with:

- URL: `https://<your-caye-host>/api/mcp`
- Authorization: `Bearer <CAYE_MCP_FOUNDER_TOKEN>`
- Protocol: `2026-07-28`

Modern requests use the MCP headers required by the protocol (`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for tool calls). Current SDK clients emit these automatically.

The v0.1 tool surface is intentionally read-only for both OAuth and server-to-server clients:

- `caye_context_snapshot`
- `caye_goals_list`
- `caye_attention_list`
- `caye_engineering_artifacts_list`
- `caye_property_list` (no arguments; never workspace-scoped — discovers founder-visible properties by name/location so a fresh session can find a valid `propertyId` without already knowing one)
- `caye_property_snapshot` (takes a `propertyId` from `caye_property_list`, not a `workspaceId` — the founder gateway resolves the owning workspace canonically from the property itself)

No SQL, storage, generic RPC, arbitrary HTTP, filesystem, or write capability is exposed by this adapter.
