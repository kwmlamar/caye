import { describe, expect, it } from 'vitest'
import pkg from './package.json'
import nextConfig from './next.config'

describe('serverless Chromium deployment configuration', () => {
  it('keeps browser dependencies server-only and traces the bundled Linux binary only for the founder admin route', () => {
    expect(nextConfig.serverExternalPackages).toEqual(expect.arrayContaining(['@sparticuz/chromium', 'playwright-core']))
    expect(nextConfig.outputFileTracingIncludes).toEqual({
      '/api/founder/admin-shell': ['./node_modules/@sparticuz/chromium/bin/**/*'],
    })
  })

  it('requires the Node runtime supported by the packaged Chromium release', () => {
    expect(pkg.engines?.node).toBe('24.x')
  })
})
