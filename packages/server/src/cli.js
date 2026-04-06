#!/usr/bin/env node
/**
 * Chroxy CLI entry point.
 *
 * Command implementations live in cli/ modules. This file only
 * sets up Commander, registers commands, and calls parse().
 */
import './version-check.js'
import { Command } from 'commander'
import { createRequire } from 'module'

import { registerInitCommand } from './cli/init-cmd.js'
import { registerServerCommands } from './cli/server-cmd.js'
import { registerConfigCommand } from './cli/config-cmd.js'
import { registerTunnelCommand } from './cli/tunnel-cmd.js'
import { registerDoctorCommand } from './cli/doctor-cmd.js'
import { registerDeployCommand } from './cli/deploy-cmd.js'
import { registerSessionCommands } from './cli/session-cmd.js'
import { registerServiceCommand } from './cli/service-cmd.js'
import { registerUpdateCommand } from './cli/update-cmd.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const program = new Command()

program
  .name('chroxy')
  .description('Remote terminal for Claude Code from your phone')
  .version(version)

registerInitCommand(program)
registerServerCommands(program)
registerConfigCommand(program)
registerTunnelCommand(program)
registerDoctorCommand(program)
registerDeployCommand(program)
registerSessionCommands(program)
registerServiceCommand(program)
registerUpdateCommand(program)

program.parse()
