export type RecoveryDecision =
  | { action: 'reply'; content: string }
  | { action: 'hold' | 'ignore'; reason: string }

export interface StaleHoldRecoveryDriver {
  generate(): Promise<RecoveryDecision>
  block(reason: string): Promise<void>
  prepare(subject: string, body: string, sentAt: string): Promise<void>
  send(body: string): Promise<{ messageId: string | null }>
  complete(sentAt: string, providerMessageId: string): Promise<'sent' | 'sent_hold_preserved'>
  markUnknown(reason: string): Promise<void>
}

/**
 * Runs after the SQL claim has proved the recovery preconditions. It never
 * retries a provider attempt: after prepare() the durable receipt is the only
 * authority, and an exception leaves the original human hold in place.
 */
export async function deliverStaleSalesHoldRecovery(
  driver: StaleHoldRecoveryDriver,
  subject: string,
  now = () => new Date().toISOString(),
): Promise<'sent' | 'sent_hold_preserved' | 'blocked' | 'delivery_unknown'> {
  let decision: RecoveryDecision
  try {
    decision = await driver.generate()
  } catch (error) {
    await driver.block(`generation failed: ${error instanceof Error ? error.message : String(error)}`)
    return 'blocked'
  }
  if (decision.action !== 'reply') {
    await driver.block(`canonical Sales path did not authorize a reply: ${decision.reason}`)
    return 'blocked'
  }
  try {
    await driver.prepare(subject, decision.content, now())
  } catch (error) {
    // No provider call occurred. The claim stays held and a later explicit
    // operator review can inspect the receipt rather than silently retrying.
    await driver.block(`outbound preparation failed: ${error instanceof Error ? error.message : String(error)}`)
    return 'blocked'
  }
  try {
    const delivery = await driver.send(decision.content)
    // Zoho accepted the request but omitted its durable message identifier.
    // Do not clear the hold or attempt another send: delivery is uncertain.
    if (!delivery.messageId) {
      await driver.markUnknown('provider accepted the request without a message id')
      return 'delivery_unknown'
    }
    // Await inside this try so a final database failure is converted to the
    // same no-retry uncertain state rather than escaping the route.
    return await driver.complete(now(), delivery.messageId)
  } catch (error) {
    await driver.markUnknown(`provider delivery outcome unknown: ${error instanceof Error ? error.message : String(error)}`)
    return 'delivery_unknown'
  }
}
