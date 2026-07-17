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
    const manager = new OrchestrationManager({
      sessionManager,
      ledger: new RunLedger({ baseDir: join(chroxyDir, 'orchestration') }),
      turnDriver: new TurnDriver({ sessionManager, log }),
      gitOps: createGitOps(),
      config,
      roles: config?.orchestration?.roles || null,
      validateCwd: (cwd) => validateCwdAllowed(cwd, config),
      permissionGateFactory: (opts) => new OrchestrationPermissionGate(opts),
      log,
    })
    log?.info?.('Orchestration engine enabled (features.orchestration)')
    return manager
  } catch (err) {
    log?.warn?.(`Orchestration engine failed to initialize — feature disabled for this boot: ${err?.message || err}`)
    return null
  }
}
