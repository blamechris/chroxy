// Test double for utils/bounded-regex-worker.js: a worker that comes online but
// never attaches a handler and never posts ready. An interval keeps it alive.
setInterval(() => {}, 1000)
