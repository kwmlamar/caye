import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Vercel output tracing deploys these server-only browser runtime files while
  // the server bundle keeps both packages external. `playwright-core` reads
  // browsers.json at module initialization, so tracing only the Chromium
  // archive is insufficient and causes the founder Admin Shell function to
  // fail before authorization with MODULE_NOT_FOUND in production.
  serverExternalPackages: ['@sparticuz/chromium', 'playwright-core'],
  outputFileTracingIncludes: {
    // `executablePath()` reads these compressed Linux artifacts at runtime;
    // Playwright Core also loads browsers.json as a non-JS runtime asset.
    // Keep both includes route-scoped rather than broadening every function.
    '/api/founder/admin-shell': [
      './node_modules/@sparticuz/chromium/bin/**/*',
      './node_modules/playwright-core/browsers.json',
    ],
  },
}

export default nextConfig
