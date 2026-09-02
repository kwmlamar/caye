import { DispatchAmbiguousError } from '@/lib/whatsapp/channel-dispatch'

/** Classifies failures using the last known transport phase. */
export function classifyFreightSendFailure(providerAccepted: boolean, error: unknown): unknown {
  return providerAccepted && !(error instanceof DispatchAmbiguousError)
    ? new DispatchAmbiguousError(`Gmail accepted the freight email but local persistence failed: ${error instanceof Error ? error.message : String(error)}`, true)
    : error
}
