/**
 * Boot-time factory for the OrchestrationManager (epic #6691, E-4). Isolated so
 * the daemon-boot wiring in server-cli.js is testable: it returns a fully-wired
 * manager when the feature is on, null when it's off, and — critically — null
 * (never a throw) when construction fails, so the orchestration feature can
 * NEVER break daemon boot.
 */

import { join } from 'node:path'
import { isOrchestrationEnabled } from '../config.js'
import { validateCwdAllowed } from '../handler-utils.js'
import { OrchestrationManager } from './orchestration-manager.js'
import { RunLedger } from './run-ledger.js'
import { TurnDriver } from './turn-driver.js'
import { createGitOps } from './git-ops.js'
import { OrchestrationPermissionGate } from './permission-gate.js'

export function buildOrchestrationManager({ sessionManager, config, chroxyDir, log = null } = {}) {
  if (!isOrchestrationEnabled(config)) return null
  try {
    const ledger = new RunLedger({ baseDir: join(chroxyDir, 'orchestration') })
    // Load prior runs from disk BEFORE anything writes: without this, the first
    // post-restart createRun would rewrite runs-index.json from the empty
    // in-memory map, clobbering the durable index. Pure load + journal replay —
    // no run is auto-resumed (in-flight runs stay at their last persisted
    // status; full restart-reconcile — suspend/interrupted marking, orphan
    // worktree sweep — is tracked in #6743).
    const recovered = ledger.recoverRuns()
    if (recovered.length) log?.info?.(`Orchestration: recovered ${recovered.length} run record(s) from disk`)
    const turnDriver = new TurnDriver({ sessionManager, log })
    const manager = new OrchestrationManager({
      sessionManager,
      ledger,
      turnDriver,
      gitOps: createGitOps(),
      config,
      roles: config?.orchestration?.roles || null,
      validateCwd: (cwd) => validateCwdAllowed(cwd, config),
      permissionGateFactory: (opts) => new OrchestrationPermissionGate(opts),
      log,
    })
    // The factory owns construction, so it owns teardown: extend dispose() to
    // also stop the turn driver (SessionManager listeners) and flush the ledger.
    const managerDispose = manager.dispose.bind(manager)
    manager.dispose = () => {
      managerDispose()
      try { turnDriver.dispose() } catch { /* idempotent best-effort */ }
      try { ledger.dispose() } catch { /* flushes pending snapshot writes */ }
    }
    log?.info?.('Orchestration engine enabled (features.orchestration)')
    return manager
  } catch (err) {
    log?.warn?.(`Orchestration engine failed to initialize — feature disabled for this boot: ${err?.message || err}`)
    return null
  }
}
