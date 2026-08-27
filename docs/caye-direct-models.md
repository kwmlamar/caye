# Caye Direct model setup

Caye Direct's model router is founder-only. It does not run on customer WhatsApp/front-desk paths.

Local development may enable subscription CLI bridges with `CAYE_DIRECT_LOCAL_BRIDGE=1`; authenticate Claude Code and Codex CLIs locally before using them. Never configure subscription CLI authentication in Vercel.

Cloud/API backends use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and optional `OPENROUTER_API_KEY`. OpenRouter additionally accepts `OPENROUTER_MODEL` for an explicit model ID (default `openai/gpt-4.1-mini`). It is only a fallback backend in Caye's existing deterministic router; it never selects its own provider or replaces Caye's policy. The adapter sends OpenRouter's `data_collection: deny` provider preference.

## Routine inference routing

Frontier inference remains Caye's default and authoritative path. A caller may explicitly opt into the separate `runInference({ tier: 'routine', ... })` boundary for bounded, non-consequential cognition only. The boundary never guesses eligibility, and it does not execute actions: deterministic authority, state, evidence, validation, and execution guards remain outside it.

Routine routing is disabled unless all of these are set:

```bash
CAYE_ROUTINE_MODEL_ENABLED=true
CAYE_ROUTINE_MODEL_BASE_URL=https://provider.example/v1
CAYE_ROUTINE_MODEL_API_KEY=replace-with-secret
CAYE_ROUTINE_MODEL=provider-small-model
# Optional; defaults to 15000
CAYE_ROUTINE_MODEL_TIMEOUT_MS=10000
```

The endpoint must implement OpenAI-compatible `POST /chat/completions`. Start with no migrated production callers, then enable the configuration in a non-production environment and migrate only a reviewed, explicitly bounded call site. A missing configuration, timeout, non-2xx response, transport error, malformed/empty response, or a routine model's structured escalation all rerun the existing frontier callback before downstream execution. Do not migrate payments, commitments, authority decisions, booking truth, destructive operations, durable memory/procedure writes, or high-risk outbound communication.

`OPENAI_API_MODEL` optionally overrides the OpenAI API model (default `gpt-4.1`). Health reports only availability/auth state, never keys or raw provider errors.
