import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executablePath, launch, chromiumRuntime } = vi.hoisted(() => {
  const executablePath = vi.fn()
  const launch = vi.fn()
  return {
    executablePath,
    launch,
    chromiumRuntime: {
      args: ['--single-process', '--no-sandbox'],
      setGraphicsMode: true,
      executablePath,
    },
  }
})

vi.mock('@sparticuz/chromium', () => ({ default: chromiumRuntime }))
vi.mock('playwright-core', () => ({ chromium: { launch } }))

import { launchServerlessChromium, SERVERLESS_CHROMIUM_PACKAGE } from './serverless-chromium'

describe('serverless Chromium launcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chromiumRuntime.setGraphicsMode = true
    executablePath.mockResolvedValue('/tmp/chromium')
    launch.mockResolvedValue({})
  })

  it('launches only the packaged serverless binary, never a Playwright developer cache', async () => {
    await expect(launchServerlessChromium()).resolves.toEqual({})

    expect(SERVERLESS_CHROMIUM_PACKAGE).toBe('@sparticuz/chromium')
    expect(executablePath).toHaveBeenCalledWith()
    expect(chromiumRuntime.setGraphicsMode).toBe(false)
    expect(launch).toHaveBeenCalledWith({ args: chromiumRuntime.args, executablePath: '/tmp/chromium', headless: true })
  })

  it('fails closed instead of accepting a local-machine executable path', async () => {
    executablePath.mockResolvedValue('/Users/founder/Library/Caches/ms-playwright/chromium')

    await expect(launchServerlessChromium()).rejects.toThrow(/ephemeral runtime/i)
    expect(launch).not.toHaveBeenCalled()
  })
})
