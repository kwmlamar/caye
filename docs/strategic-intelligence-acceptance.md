# Strategic Intelligence / Decision Layer acceptance

This layer is intentionally an adapter over canonical Caye systems. It must not become a second attention, authority, decision, objective, or evidence substrate.

## Production acceptance tests

1. **Level 0 suppression**: ingest a fresh but irrelevant observation. Verify no attention item, recommendation, or human interruption is created.
2. **Level 1 monitoring**: ingest relevant weak evidence. Verify it remains monitored and does not produce an actionable recommendation.
3. **Level 2 research escalation**: strengthen the signal past the research threshold. Verify deeper autonomous research is requested and no human interruption occurs.
4. **Level 3 cross-check**: make the signal material with credible evidence. Verify an independent cross-check/synthesis is requested before actionability.
5. **Level 4 recommendation**: make the signal actionable but non-urgent. Verify a recommendation artifact is available to Caye Direct / weekly brief and no immediate attention interruption occurs.
6. **Level 5 interruption**: supply fresh, material, time-sensitive, independently corroborated evidence. Verify exactly one canonical attention item is created for the resolved authority holder.
7. **Notification spam**: replay the same Level-5 recommendation with the same material fingerprint. Verify no second interruption is created.
8. **Weak evidence**: reduce confidence/independence. Verify the signal cannot reach Level 4/5.
9. **Stale intelligence**: mark all supporting evidence stale. Verify it cannot reach actionable status.
10. **Conflicting evidence**: introduce a credible contradiction. Verify confidence/escalation falls and the contradiction is represented in synthesis.
11. **Incorrect authority**: invoke a business recommendation while conversational actor differs from canonical authority. Verify attention targets only canonical authority. If authority cannot be resolved, verify no interruption occurs.
12. **Raw ID leakage**: include UUIDs/internal id labels in recommendation inputs. Verify human-facing output contains no raw UUID/internal implementation identifiers.
13. **Unsupported certainty**: attempt high materiality/urgency with low-confidence single-source evidence. Verify Level 5 is impossible.
14. **Repeated unchanged recommendation**: regenerate the same recommendation across research runs. Verify it is suppressed from repeat interruption and weekly brief duplication.
15. **Material new evidence**: add evidence that changes the material fingerprint and recommendation. Verify the new recommendation is surfaced and can interrupt only if it independently satisfies Level 5.
16. **Weekly brief**: generate a seven-day brief. Verify it contains only material changes, belief updates, discoveries, wildcard/cross-domain insights, ranked opportunities, changed threats/assumptions, concrete next actions, and unresolved investigations. Verify it is not a chronological news digest.
17. **Caye Direct**: ask each supported natural-language strategic question. Verify responses use persisted evidence/beliefs/recommendations, cite concise evidence, expose uncertainty/counterarguments, and never expose internal IDs.

## Integration requirement before merge

Wire `StrategicDependencies.resolveAuthority` to the repository's canonical authority resolver and `enqueueCanonicalAttention` to the canonical attention service. Wire research/cross-check callbacks to the canonical research desk runtime. Do not replace those seams with new tables or notification channels.
