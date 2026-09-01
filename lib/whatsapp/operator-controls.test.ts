import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { parseWorkspaceSwitchCommand } from './operator-controls'

describe('parseWorkspaceSwitchCommand', () => {
  it('parses the exact message that failed in production', () => {
    expect(parseWorkspaceSwitchCommand('Switch to ods')).toBe('ods')
  })

  it('accepts the phrasings the switch_workspace tool documents', () => {
    expect(parseWorkspaceSwitchCommand('switch to bimini')).toBe('bimini')
    expect(parseWorkspaceSwitchCommand('go to Simply Dave')).toBe('Simply Dave')
    expect(parseWorkspaceSwitchCommand('change to ODS Construction Co.')).toBe('ODS Construction Co')
    expect(parseWorkspaceSwitchCommand('take me to bowcar')).toBe('bowcar')
    expect(parseWorkspaceSwitchCommand('switch back to bimini')).toBe('bimini')
  })

  it('strips filler around the name', () => {
    expect(parseWorkspaceSwitchCommand('switch to the ods workspace')).toBe('ods')
    expect(parseWorkspaceSwitchCommand('switch to ods please')).toBe('ods')
    expect(parseWorkspaceSwitchCommand('Switch to ods!')).toBe('ods')
  })

  it('is case and whitespace insensitive', () => {
    expect(parseWorkspaceSwitchCommand('   SWITCH TO   ods  ')).toBe('ods')
  })

  // The dangerous direction: a false positive hijacks a real conversation.
  it('does not hijack prose that merely starts with a switch verb', () => {
    expect(parseWorkspaceSwitchCommand('switch to a more formal tone for the rest of the day')).toBeNull()
    expect(
      parseWorkspaceSwitchCommand('go to the marina and check whether the tram stop sign is still up')
    ).toBeNull()
  })

  it('ignores messages that are not switch commands at all', () => {
    expect(parseWorkspaceSwitchCommand('Try again')).toBeNull()
    expect(parseWorkspaceSwitchCommand('what is the meeting point for the heritage tour?')).toBeNull()
    expect(parseWorkspaceSwitchCommand('')).toBeNull()
  })

  it('ignores multi-line messages, which are never bare controls', () => {
    expect(parseWorkspaceSwitchCommand('switch to ods\nand then send the quote')).toBeNull()
  })

  it('rejects a target too short to match a business name', () => {
    expect(parseWorkspaceSwitchCommand('switch to a')).toBeNull()
  })
})

describe('resolveWorkspaceSwitch — authorization is delegated, never reimplemented', () => {
  it('refuses non-founder callers outright', async () => {
    const { resolveWorkspaceSwitch } = await import('./operator-controls')
    expect(await resolveWorkspaceSwitch('ods', 'ws-1', 'owner')).toBeNull()
    expect(await resolveWorkspaceSwitch('ods', 'ws-1', 'staff')).toBeNull()
  })

  it('confirms deterministically when the tool authorizes the switch', async () => {
    vi.resetModules()
    vi.doMock('@/lib/caye-agent/tools/write-low/switch-workspace', () => ({
      switchWorkspace: {
        execute: vi.fn().mockResolvedValue({
          ok: true,
          data: { switched_to: 'ODS Construction Co.', workspace_id: 'ws-ods' },
        }),
      },
    }))
    const { resolveWorkspaceSwitch } = await import('./operator-controls')
    expect(await resolveWorkspaceSwitch('ods', 'ws-bimini', 'founder')).toEqual({
      reply: "Done — you're on ODS Construction Co. now.",
      outcome: 'switched',
    })
  })

  it('surfaces an authorization denial rather than switching', async () => {
    vi.resetModules()
    vi.doMock('@/lib/caye-agent/tools/write-low/switch-workspace', () => ({
      switchWorkspace: {
        execute: vi.fn().mockResolvedValue({
          ok: false,
          error: "You don't have founder access to Someone Else Ltd.",
        }),
      },
    }))
    const { resolveWorkspaceSwitch } = await import('./operator-controls')
    const result = await resolveWorkspaceSwitch('someone else', 'ws-bimini', 'founder')
    expect(result?.outcome).toBe('unauthorized')
  })

  it('defers to the agent when no workspace matches — a regex must not answer prose', async () => {
    vi.resetModules()
    vi.doMock('@/lib/caye-agent/tools/write-low/switch-workspace', () => ({
      switchWorkspace: {
        execute: vi.fn().mockResolvedValue({ ok: false, error: 'No workspace found matching "vibes".' }),
      },
    }))
    const { resolveWorkspaceSwitch } = await import('./operator-controls')
    expect(await resolveWorkspaceSwitch('vibes', 'ws-bimini', 'founder')).toBeNull()
  })

  it('defers to the agent when the tool throws', async () => {
    vi.resetModules()
    vi.doMock('@/lib/caye-agent/tools/write-low/switch-workspace', () => ({
      switchWorkspace: { execute: vi.fn().mockRejectedValue(new Error('db down')) },
    }))
    const { resolveWorkspaceSwitch } = await import('./operator-controls')
    expect(await resolveWorkspaceSwitch('ods', 'ws-bimini', 'founder')).toBeNull()
  })
})
