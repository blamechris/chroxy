import { defineConfig } from 'vitest/config'

// #7300. store-core previously ran `vitest run` with no config file at all, so
// it inherited every default silently — including testTimeout 5000ms and one
// worker per core. That is the same gap packages/dashboard had, except stated by
// omission of the whole file rather than omission of three keys, which is why an
// audit of "packages with a bad vitest config" would not have found it.
//
// Discovery is deliberately left on vitest's defaults: this file exists to bound
// the clock and the worker count, not to change which tests run.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: '50%',
  },
})
