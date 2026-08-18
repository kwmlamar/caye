# Caye Developer Agent

Caye is one AI employee for small businesses. The product should feel like employing one capable, persistent person, not operating a collection of bots or software tools.

Caye's core operating loop is:

**Observe → Understand → Notice → Investigate → Decide → Plan → Act / Ask Approval → Follow Through → Measure → Remember**

The customer-facing and owner-facing interfaces are surfaces of the same employee. Preserve continuity of identity, memory, authority, and behavior across channels.

## Sources of truth

- **Linear CAY-* issues** are the canonical product/task record: problem, rationale, desired behavior, constraints, acceptance criteria, and remaining risks.
- **GitHub** is the source of truth for code, schema, commits, PRs, and CI.
- Remote GitHub Actions workers may not have Linear credentials. The GitHub dispatch issue/comment must therefore mirror the relevant CAY-* requirements. If the dispatch packet is incomplete or contradicts the repository, stop and report the ambiguity rather than inventing product requirements.

## Before changing code

1. Read the complete GitHub issue/comment that dispatched the task, including the CAY-* identifier and acceptance criteria.
2. Inspect the current repository state and relevant runtime paths before proposing a fix.
3. Verify material assumptions against code, tests, migrations, and existing behavior.
4. Identify whether the task touches authority, customer communication, money, identity, workspace isolation, persistence, migrations, or production side effects.
5. Keep the task scoped. Do not absorb unrelated cleanup or nearby experimental work.

## Usage discipline

The normal developer worker runs on Sonnet and has an 80-turn emergency ceiling, not an 80-turn target.

- Aim to finish ordinary scoped implementation tasks in roughly 20–30 turns when practical.
- Do not perform a broad repo audit unless the dispatch explicitly asks for one.
- Reuse investigation already recorded in the issue/PR instead of rediscovering the same code paths.
- Read narrowly: start with named incidents, files, callers, tests, and schema relevant to the task; widen only when evidence requires it.
- Once root cause is established, implement and validate. Do not keep exploring merely because more context exists.
- Prefer targeted tests first. Run broader validation only when the change warrants it.
- If the requested work is fundamentally architectural, security-sensitive, or ambiguous enough to need substantially more reasoning, stop and report that escalation rather than consuming the full turn budget by default. Product/architecture review may explicitly invoke the separate deep-review path.

## Product invariants

- One employee, not a visible multi-agent product.
- Conversation-first owner experience. Do not send owners elsewhere to complete work Caye can present or handle in the current conversation.
- Drafting for an owner happens inline in the active Caye conversation unless the product requirements explicitly establish a different future behavior.
- A draft is not a send. A staged action is not an executed action.
- Never claim an action completed without execution evidence.
- Consequential actions must obey the deterministic authority/confirmation architecture. Do not replace code-enforced safety with prompt instructions.
- Workspace isolation, operator scoping, provenance, idempotency, and auditability are non-negotiable.
- Internal tool names, queue names, database language, TTLs, and implementation mechanics must not leak into owner/customer-facing prose.
- Prefer strengthening shared architecture over adding another parallel special-case path.
- Do not delete or consolidate production code merely because it looks redundant. Prove callers, replacement behavior, data dependencies, and regression coverage first.

## Engineering rules

- Never commit directly to `main`.
- Work only on the branch created/used for the dispatched task.
- Never merge your own PR.
- Never deploy to production, mutate production databases, apply production migrations, send real customer/operator messages, or use production credentials unless the dispatch issue explicitly authorizes a narrowly defined operation and the workflow has been intentionally designed for it. The normal coding agent has no such authority.
- Never add secrets to code, logs, issues, commits, or PR descriptions.
- Do not silently broaden scope to fix unrelated failures.
- Prefer the smallest architecture-consistent fix that fully closes the reported failure mode.
- For incident-derived fixes, preserve the real incident as regression coverage when practical.

## Validation before completion

Run the strongest relevant checks available for the task:

1. targeted regression tests for the changed behavior;
2. relevant broader test suite;
3. TypeScript/typecheck;
4. production build when applicable;
5. migration/schema validation when applicable;
6. final diff inspection for unrelated changes.

If a check cannot run in the GitHub runner, state exactly why. Never report a check as passing when it did not run.

## Pull request contract

Open or update a PR for the implementation. The PR must include:

- CAY-* identifier;
- problem/root cause;
- behavior changed;
- important architectural decisions;
- exact tests/checks run and results;
- migrations required or explicitly not required;
- real external side effects performed, normally **none**;
- remaining concrete risks or follow-up work;
- anything that deviated from the dispatch issue and why.

Do not merge the PR. Product/architecture review and merge remain controlled outside the implementation agent.

## When uncertain

Read more code before writing more code. If evidence is still insufficient, report the uncertainty in the issue/PR rather than guessing. Caye is production software used in real businesses; confidence theater is not verification.
