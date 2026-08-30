import type { NextConfig } from 'next'

const browserRuntimeFiles = [
  './node_modules/@sparticuz/chromium/bin/**/*',
  './node_modules/playwright-core/browsers.json',
]

const nextConfig: NextConfig = {
  // Vercel output tracing deploys these server-only browser runtime files while
  // the server bundle keeps both packages external. `playwright-core` reads
  // browsers.json at module initialization, so tracing only the Chromium
  // archive is insufficient and causes a founder control-plane function to
  // fail before authorization with MODULE_NOT_FOUND in production.
  serverExternalPackages: ['@sparticuz/chromium', 'playwright-core'],
  outputFileTracingIncludes: {
    // The Admin Shell remains temporarily traceable while it is retired, but
    // Caye Direct is the canonical founder control plane and can now invoke the
    // job-search browser executor itself. Keep this scoped to founder routes.
    '/api/founder/admin-shell': browserRuntimeFiles,
    '/api/founder/caye-direct/**': browserRuntimeFiles,
  },
}

export default nextConfig
