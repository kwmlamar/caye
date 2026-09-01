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
    // The autonomous application worker runs the same browser executor without
    // a founder in the loop. Omitting it reproduced exactly the failure this
    // config exists to prevent: the route 500'd on module initialization in
    // production, before its CRON_SECRET check, while every other cron route
    // returned 401. Any route that can reach executeApplication needs these
    // files traced — see the contract test in lib/job-search/execution/
    // browser-runtime-tracing.test.ts.
    '/api/caye/job-search-apply': browserRuntimeFiles,
  },
}

export default nextConfig
