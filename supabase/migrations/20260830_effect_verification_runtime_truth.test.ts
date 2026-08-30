name: Effect verification CI

on:
  pull_request:
    paths:
      - 'lib/effect-verification.ts'
      - 'lib/effect-verification.test.ts'
      - 'lib/effect-verification-store.ts'
      - 'lib/calendar-effect-verification.ts'
      - 'lib/calendar-sync.ts'
      - 'supabase/migrations/20260830_effect_verification_runtime_truth.sql'
      - '.github/workflows/effect-verification-ci.yml'

permissions:
  contents: read

jobs:
  runtime-truth:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test -- lib/effect-verification.test.ts
      - run: npx tsc --noEmit
