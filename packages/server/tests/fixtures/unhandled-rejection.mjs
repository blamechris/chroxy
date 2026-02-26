// Test fixture: triggers an unhandled promise rejection with a global handler
// The handler should log [fatal] and exit with code 1

process.on('unhandledRejection', (err) => {
  console.error('[fatal] Unhandled rejection:', err)
  process.exit(1)
})

// Trigger an unhandled rejection
Promise.reject(new Error('test unhandled rejection'))
