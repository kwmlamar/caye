import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Vercel output tracing deploys this package's Chromium archive while the
  // server bundle keeps its native/server-only files external.
  serverExternalPackages: ['@sparticuz/chromium', 'playwright-core'],
  outputFileTracingIncludes: {
    // `executablePath()` reads these compressed Linux artifacts at runtime;
    // they are not JS imports, so output tracing needs this explicit route-
    // scoped inclusion. Do not broaden this to every function.
    '/api/founder/admin-shell': ['./node_modules/@sparticuz/chromium/bin/**/*'],
  },
}

export default nextConfig
