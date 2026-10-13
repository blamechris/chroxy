/** Allow owned preview cleanup to settle, with an independent exit ceiling. */
export function exitAfterPreviewCleanup(wsServer, { exit, delayMs = 100, ceilingMs = 5500, log } = {}) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(ceiling)
    setTimeout(exit, delayMs)
  }
  const ceiling = setTimeout(() => {
    log?.error?.('Preview cleanup did not settle before the shutdown ceiling; process exit will proceed')
    finish()
  }, ceilingMs)
  try {
    Promise.resolve(wsServer?.settleDevPreviews?.()).catch(err => {
      log?.error?.(`Preview cleanup failed during shutdown: ${err?.message || err}`)
    }).finally(finish)
  } catch (err) {
    log?.error?.(`Preview cleanup failed during shutdown: ${err?.message || err}`)
    finish()
  }
}
