import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'

interface DirectRunContext { runId: string }
const storage = new AsyncLocalStorage<DirectRunContext>()

export function withDirectRunContext<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ runId }, fn)
}

export function currentDirectRunId(): string | null {
  return storage.getStore()?.runId ?? null
}
