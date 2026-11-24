// The freshness model's checks now lives in src/freshness so the real reconciler
// and the model tests share one implementation.
export * from '../../../src/freshness/checks.js'
