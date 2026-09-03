import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'lib/**/*.test.ts',
      'app/**/*.test.ts',
      // scripts/whatsapp-simulate-inbound.mjs ships its own vitest suite
      // alongside the script, not under lib/ or app/. Without this, an
      // explicit `vitest run scripts/whatsapp-simulate-inbound.test.ts`
      // silently reports "no test files found". Scoped to this one file
      // rather than a `scripts/**/*.test.ts` glob: at least one other
      // scripts/*.test.ts in this repo (bedrock-readonly-smoke.test.ts) is
      // already failing outside vitest's include filter today, and widening
      // the glob would pull it into every `vitest run` unrelated to this
      // change.
      'scripts/whatsapp-simulate-inbound.test.ts',
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
