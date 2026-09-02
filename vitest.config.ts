import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'lib/**/*.test.ts',
      'app/**/*.test.ts',
      // Deliberately narrow: include integration migration contracts without
      // sweeping unrelated Supabase fixtures into the normal Vitest suite.
      'supabase/tests/domain-event-migration-contract.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      'server-only': path.resolve(__dirname, 'test/server-only.ts'),
    },
  },
})
