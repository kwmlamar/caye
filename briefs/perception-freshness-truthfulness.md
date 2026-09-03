# Perception freshness truthfulness

`perception.status` must report what is autonomous **now**, not merely what was last written as active.

Perception source and capability rows carry `fresh_until`. Without read-time normalization, an otherwise healthy source can remain stored as `active` after its freshness window expires, causing founder/Direction reads to overstate active and autonomous perception until another write updates the row.

This patch treats expired active sources as `stale` and expired active capability evidence as `limited` with `autonomousNow=false` in the read projection. It does not mutate database history and does not invent freshness where no deadline exists.

The database remains the durable observation ledger. The capability read becomes time-aware so stale evidence cannot masquerade as current awareness.
