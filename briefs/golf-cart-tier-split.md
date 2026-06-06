# Brief: Split Golf Cart Guided Tour into two services with proper per-pax tiers

## Why
The Golf Cart Guided Tour currently exists as a single service in `booking_services` with two flat tiers in `service_pricing_tiers` ("Orientation 1hr" and "Fully Guided 2hr"). Every other Bimini tour follows a structured pattern: one service per tour, with three tiers — Adult, Private (2 max), Private Group (min 4). The golf cart is the odd one out.

This mismatch caused a real lost-momentum incident on 2026-06-05: lead Jeff Montenaro (4 adults, June 25, 2-hour Fully Guided) submitted the intake form, Caye correctly asked which variant, Jeff replied "the 2-hour Fully Guided Tour," and Caye stalled on pricing because the deterministic tier returned only "Starting at $350" (ambiguous above 4 pax). She punted to Karenda for a number that was sitting in `workspace_ai_config.pricing_info` ($190/adult group rate, min 4 → 4 × $190 = $760). A label-level patch was applied 2026-06-05 to unblock immediate quoting, but the structural fix is to model the two golf cart variants as separate services so Caye's deterministic pricing logic works the same way for every product.

## Current state (Bimini workspace `653257d9-c0f1-4271-be6d-3e2596fd893e`)

One service:
- `service_id = 93648097-b79c-4b1f-ad75-056b5b7f39ff`, name "Golf Cart Guided Tour"

Two tiers under that service (post 2026-06-05 label patch):
- "Orientation 1hr (group)" — $110/adult, $75/child, private 2-pax $199 flat (id `551ca2d3-...`)
- "Fully Guided 2hr (group)" — $190/adult, $150/child, private 2-pax $350 flat (id `48d4206f-...`)

## Target state

Two separate services in `booking_services`:
1. **Golf Cart Orientation (1 hr)**
2. **Golf Cart Fully Guided (2 hrs)**

Each with three tiers in `service_pricing_tiers`, matching the pattern of all other Bimini tours:

### Golf Cart Orientation (1 hr)
| tier_name | price_label | price_amount | group_size_min | group_size_max | is_flat |
|---|---|---|---|---|---|
| Adult | $110/person | 110.00 | 1 | 1 | false |
| Private (2 max) | $199 flat (2 people max) | 199.00 | 2 | 2 | true |
| Private Group (min 4) | $110/person, child $75/person | 110.00 | 4 | 50 | false |

### Golf Cart Fully Guided (2 hrs)
| tier_name | price_label | price_amount | group_size_min | group_size_max | is_flat |
|---|---|---|---|---|---|
| Adult | $190/person | 190.00 | 1 | 1 | false |
| Private (2 max) | $350 flat (2 people max) | 350.00 | 2 | 2 | true |
| Private Group (min 4) | $190/person, child $150/person | 190.00 | 4 | 50 | false |

Note: child pricing is currently embedded in the `price_label` because the schema does not have separate child tiers for other tours either. Keeping the convention consistent. A future schema iteration to add child pricing as a first-class field should apply to **all** services, not just golf cart.

## Migration steps

1. Insert two new rows into `booking_services` for the two variants. Preserve the original service_id `93648097-...` for one of them (probably Fully Guided since it's the more common booking) to minimize broken references, and create a new service_id for the other (Orientation).
2. Insert six new rows into `service_pricing_tiers` per the tables above.
3. Soft-delete or mark inactive the two existing tier rows `551ca2d3-...` and `48d4206f-...`.
4. Update `workspace_ai_config.pricing_info` for Bimini to reflect the two-service split (the current pricing_info already has the right numbers, just needs the service-name framing).
5. Verify Caye's price-resolution code path queries by service_id and tier match, and that the existing booking flow doesn't have hardcoded references to the old single service.

## Acceptance

- Lead asking for "Golf Cart Fully Guided, 4 adults" → Caye resolves to Private Group tier, quotes 4 × $190 = $760 + 25% deposit, asks to lock in. No stall.
- Lead asking for "Golf Cart, 2 people, just want a quick orientation" → resolves to Orientation Private (2 max), quotes $199 flat.
- Existing bookings tied to the old service_id still load correctly (either by preserving the id on one variant or by writing a one-off update for any historical rows).

## Notes

- Do not invent prices not in this document. The numbers come from Karenda's actual June 2 quotes (`unified_messages` rows in conversations with Chris Stelton and Vanessa Carmona).
- Discounted group rates ($65/pp for 20-pax Orientation, $95/pp for 20-pax Fully Guided) are owner-discretion discounts off the standard $85/$110 large-group pricing, not standard tiers. Out of scope for this brief.
