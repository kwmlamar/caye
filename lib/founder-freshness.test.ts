import { describe, it, expect, vi } from 'vitest'
import { subscribeStale, emitStale, ALL_TOPICS } from '@/lib/founder-freshness'

const WS = 'workspace-a'
const OTHER_WS = 'workspace-b'

describe('founder freshness bus', () => {
  it('notifies a subscriber whose topic was marked stale', () => {
    const notify = vi.fn()
    const off = subscribeStale(WS, ['conversations'], notify)

    emitStale(WS, ['conversations'])

    expect(notify).toHaveBeenCalledTimes(1)
    off()
  })

  it('ignores topics the subscriber does not own', () => {
    const notify = vi.fn()
    const off = subscribeStale(WS, ['conversations'], notify)

    emitStale(WS, ['cost'])

    expect(notify).not.toHaveBeenCalled()
    off()
  })

  // Workspace switching is a route navigation, so several workspaces'
  // panels can briefly overlap. A change in one must never refetch another.
  it('scopes notifications to one workspace', () => {
    const notify = vi.fn()
    const off = subscribeStale(WS, ['conversations'], notify)

    emitStale(OTHER_WS, ['conversations'])

    expect(notify).not.toHaveBeenCalled()
    off()
  })

  // A settled Caye Direct turn emits every topic at once; a panel owning
  // three of them should still only refetch once.
  it('notifies once per emit even when several of its topics match', () => {
    const notify = vi.fn()
    const off = subscribeStale(WS, ['bookings', 'escalations', 'cost'], notify)

    emitStale(WS, ALL_TOPICS)

    expect(notify).toHaveBeenCalledTimes(1)
    off()
  })

  it('stops notifying after unsubscribe', () => {
    const notify = vi.fn()
    const off = subscribeStale(WS, ['conversations'], notify)
    off()

    emitStale(WS, ['conversations'])

    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies every matching subscriber', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeStale(WS, ['conversations'], a)
    const offB = subscribeStale(WS, ['conversations', 'cost'], b)

    emitStale(WS, ['conversations'])

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    offB()
  })

  // Panels unmount on rail switches and workspace navigations, which can
  // land in the same tick as an emit. Unsubscribing mid-notify must not
  // skip the remaining subscribers.
  it('survives a subscriber unsubscribing during its own notification', () => {
    const later = vi.fn()
    let offSelf: () => void = () => {}
    offSelf = subscribeStale(WS, ['conversations'], () => offSelf())
    const offLater = subscribeStale(WS, ['conversations'], later)

    expect(() => emitStale(WS, ['conversations'])).not.toThrow()
    expect(later).toHaveBeenCalledTimes(1)
    offLater()
  })
})
