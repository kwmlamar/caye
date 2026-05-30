# ChargeAnywhere Receipt Fixtures

Real receipts pulled 2026-05-30 from Karenda's Bimini Island Tours Zoho inbox
for receipt-parser test fixtures. See `lib/payments/receipt-parser.ts` (TBD)
for the design doc and parser implementation.

## What Caye should do with each type

| Subject | Body cue | Action |
|---|---|---|
| `Receipt` | `Response: APPROVED` | Parse → match to booking → update status to 'paid' → send customer confirmation |
| `Payment Attempt Not Completed` | `Your payment could not be completed` / `Response: Do not honor` | Notify owner ("customer tried to pay but card was declined") — do NOT update booking, do NOT email customer |
| `Settlement Details for MM/DD/YY` | Daily settlement summary | Ignore — operator finance roll-up, not customer-specific |

---

## Fixture 1 — APPROVED, 50% deposit, party of 4

**Subject:** `Receipt`
**Sender:** `noreply@chargeanywhere.com`
**Sent:** 2026-05-25 01:39:41 UTC
**Message ID (DB):** `014a12f2-a09f-4b24-8b4e-30ee746bb365`

```
*********** RECEIPT PAGE ***********

Your payment has been received and processed successfully.

Please print this receipt page and keep it for your records.

This receipt has also been emailed to  sdpettus@aol.com.

Order Information

Merchant Name: Bimini Island Tours

Merchant Email: info@tourbimini.com

DateTime: 5/24/2026 9:39:37 PM

Transaction ID: 000148474704

Invoice Number: 589

Description: 50% Deposit Combo Tour - 08/26 (4) 9:00 a.m.

Amount: $398.00

Total: $398.00

Response: APPROVED

ApprovalCode: 69236P

Credit Card Information

Card Number xxxx7873

Description
Code
Quantity
Units
Price
Total:

50% Deposition Combination Tour
1
2

$199.00
$398.00

Billing Information

Customer Name: Sonja Pettus

Address1: 164 VALLEYVIEW DRIVE

ZipCode: 35504

Country: United States
```

**Expected parse:**
- status: `success`
- customer_email: `sdpettus@aol.com`
- customer_name: `Sonja Pettus`
- amount: `398.00`
- transaction_id: `000148474704`
- invoice_number: `589`
- description_raw: `50% Deposit Combo Tour - 08/26 (4) 9:00 a.m.`
- tour_inferred: `Combo Tour`
- date_inferred: `2026-08-26`
- party_size_inferred: `4`
- start_time_inferred: `09:00`
- is_deposit: `true`
- deposit_percent: `50`

---

## Fixture 2 — APPROVED, party of 3

**Subject:** `Receipt`
**Sent:** 2026-05-24 21:29:59 UTC
**Message ID:** `8f1cb8c3-2052-465d-a3c5-01e03005c67e`

Key fields:
- `This receipt has also been emailed to lily.wyatt.0728@gmail.com.`
- `Description: North Bimini Island Tour 05/25/26 (3 pax) 10:00 a.` *(TRUNCATED — note partial "a.")*
- `Amount: $330.00`
- `Customer Name: Lily Wyatt`

**Expected parse:**
- status: `success`
- amount: `330.00`
- description shows truncation risk — parser must handle "10:00 a." as "10:00 a.m."
- tour_inferred: `North Bimini Island Tour` → matches service slug `north-bimini-historical-tour`
- date_inferred: `2026-05-25`
- party_size: `3`
- is_deposit: `false` (no deposit prefix)

---

## Fixture 3 — DECLINED retry (same invoice as #2)

**Subject:** `Payment Attempt Not Completed`
**Sent:** 2026-05-24 21:27:51 UTC (2 minutes before successful #2)
**Message ID:** `b8fa45d1-4308-4481-b86c-5a06ebe5c830`

Same `Description`, `Amount`, `Invoice Number: 588` as #2, but:
- `Your payment could not be completed.`
- `Response: Do not honor`
- Different card: `xxxx2513` vs success card `xxxx4675`
- Has expanded Billing Information (First Name, Last Name, City, State)

**Expected behavior:** Caye flags for owner ("Lily Wyatt's card was declined on invoice 588") OR silently logs if a successful receipt for the same invoice arrived within N minutes. The 2026-05-30 receipt-parser design should DECIDE this — both are reasonable.

---

## Fixture 4 — Non-tour transaction (Sponsorship)

**Sent:** 2026-05-08 13:22:36 UTC
**Message ID:** `a438ff83-79f2-4703-b04d-39324bb3dfb9`

- `Description: Sponsorship NBC Pathfinders Camporee`
- `Amount: $500.00`
- `Customer Name: Christina Shaver` (typo'd as "Customer Number:" in source)

**Expected parse:** the parser should HOLD this — no tour name match, no date, no party size. Caye notifies owner: "Received a $500 payment from Christina Shaver — looks like a sponsorship, not a tour booking. Not matching any booking."

---

## Fixture 5 — Forwarded receipt embedded in customer reply

**Sent:** 2026-05-05 16:12:24 UTC
**Message ID:** `1fd4352a-1a40-47bc-91bc-d6f94089e8ee`

Customer (`j.cramblett@verizon.net`) replied "Never mind I guess it went through. Thanks" with the original receipt quoted below. Body starts with the customer's text, then `Original message` line, then the receipt body.

**Expected behavior:** detector should NOT treat this as a receipt (sender_type=customer, not noreply@chargeanywhere.com). Receipt-detection runs only on inbound messages from the ChargeAnywhere sender.

---

## Open questions for design

1. **Card number as deduplication key for retry detection** — same invoice retried with same card vs different card?
2. **Deposit vs full payment** — when Caye sees "50% Deposit", does the booking move to `paid_deposit` (new status) or stay `pending` until the balance is settled?
3. **Tour name fuzzy match** — "North Bimini Island Tour" in receipt vs "North Bimini Heritage Tour" in booking_services. Need fuzzy match or alias table.
4. **Date format** — `08/26` (no year) — assume current year unless that date is in the past, then next year?
5. **Match strategy** — by customer_email + tour + date is most reliable. Fallback chain: + party_size, + amount. If nothing matches, hold for owner.
