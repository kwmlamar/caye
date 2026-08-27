# Caye Direct model setup

Caye Direct's model router is founder-only. It does not run on customer WhatsApp/front-desk paths.

Local development may enable subscription CLI bridges with `CAYE_DIRECT_LOCAL_BRIDGE=1`; authenticate Claude Code and Codex CLIs locally before using them. Never configure subscription CLI authentication in Vercel.

Cloud/API backends use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and optional `OPENROUTER_API_KEY`. OpenRouter additionally accepts `OPENROUTER_MODEL` for an explicit model ID (default `openai/gpt-4.1-mini`). It is only a fallback backend in Caye's existing deterministic router; it never selects its own provider or replaces Caye's policy. The adapter sends OpenRouter's `data_collection: deny` provider preference.

`OPENAI_API_MODEL` optionally overrides the OpenAI API model (default `gpt-4.1`). Health reports only availability/auth state, never keys or raw provider errors.
