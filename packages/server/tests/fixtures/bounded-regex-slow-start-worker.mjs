// Test double for utils/bounded-regex-worker.js: a worker whose module takes far
// longer to load than any sane match deadline. The thread is 'online' at once,
// but it cannot answer (or post ready) until the busy-wait ends and the real
// worker module has attached its message handler.
const until = Date.now() + 300
while (Date.now() < until) { /* hold the thread, as a slow module load would */ }
await import('../../src/utils/bounded-regex-worker.js')
