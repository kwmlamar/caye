import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@vercel/sandbox', () => ({ Sandbox: {} }))

import { resolveCadSandboxImage } from './runtime'

describe('resolveCadSandboxImage', () => {
  it('prefers the explicit CAD sandbox image', () => {
    expect(resolveCadSandboxImage({
      ENGINEERING_CAD_SANDBOX_IMAGE: 'custom-cad:v3',
      ENGINEERING_SANDBOX_IMAGE: 'caye-fea:latest',
    })).toBe('custom-cad:v3')
  })

  it('preserves a non-FEA legacy engineering image for backwards compatibility', () => {
    expect(resolveCadSandboxImage({ ENGINEERING_SANDBOX_IMAGE: 'caye-engineering:cadquery-v2' }))
      .toBe('caye-engineering:cadquery-v2')
  })

  it('never routes CAD through the FEA image', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveCadSandboxImage({ ENGINEERING_SANDBOX_IMAGE: 'caye-fea:latest' }))
      .toBe('caye-engineering:cadquery-v2')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing FEA image for CAD generation'))
    warn.mockRestore()
  })

  it('uses the validated CadQuery image when no image is configured', () => {
    expect(resolveCadSandboxImage({})).toBe('caye-engineering:cadquery-v2')
  })
})
