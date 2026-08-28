# Caye MCP adapter

Caye exposes its founder read capability layer over a stateless MCP `2026-07-28` endpoint at `/api/mcp`.

The MCP layer is transport only. It does not query Supabase directly and does not own business semantics. Tools map into the existing founder capability gateway, which owns scope and result truth.

## Server configuration

Set these server-only environment variables:

- `CAYE_MCP_FOUNDER_TOKEN`: a long random bearer token used only by trusted external reasoning clients.
- `CAYE_MCP_FOUNDER_USER_ID`: the founder Supabase auth user id that this token maps to.

If either variable is absent, MCP authentication fails closed. Never use a `NEXT_PUBLIC_*` variable for the token and never commit it.

## Client connection

Configure a compatible remote MCP client with:

- URL: `https://<your-caye-host>/api/mcp`
- Authorization: `Bearer <CAYE_MCP_FOUNDER_TOKEN>`
- Protocol: `2026-07-28`

Modern requests use the MCP headers required by the protocol (`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for tool calls). Current SDK clients emit these automatically.

The v0.1 tool surface is intentionally read-only:

- `caye_context_snapshot`
- `caye_goals_list`
- `caye_attention_list`
- `caye_engineering_artifacts_list`

No SQL, storage, generic RPC, arbitrary HTTP, filesystem, or write capability is exposed by this adapter.
