#!/usr/bin/env node

import { writeFileSync } from 'fs'
import { observeClaudeNativeRoute } from '../src/utils/claude-native-route.js'

const markerPath = process.argv[2]
const nonce = process.argv[3]
if (!markerPath || !nonce) process.exit(2)

const observed = observeClaudeNativeRoute(process.env)
writeFileSync(markerPath, JSON.stringify({
  version: 1,
  nonce,
  safe: observed.safe,
  firstPartyEndpoint: observed.firstPartyEndpoint,
  blockedKeys: observed.blockedKeys,
}), { mode: 0o600 })
