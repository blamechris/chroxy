#!/usr/bin/env node

/**
 * Generate the dashboard theme from the canonical token map.
 *
 * Source of truth: @chroxy/design-tokens (packages/design-tokens/src/tokens-data.js)
 * Outputs:         src/theme/theme.css  (CSS custom properties)
 *                  src/theme/tokens.ts  (typed token objects)
 *
 * The pipeline is INVERTED from the old "parse theme.css → emit tokens.ts"
 * direction (chat redesign #6389, Phase 0 #6390): edit tokens in the package,
 * then run this. CI (`check-tokens-fresh.mjs`) fails the build if the committed
 * outputs drift from what this would generate.
 *
 * Usage: npm run generate-tokens   (from packages/dashboard)
 */

import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { generateThemeCss, generateTokensTs } from '@chroxy/design-tokens'

const __dirname = dirname(fileURLToPath(import.meta.url))
const themeDir = resolve(__dirname, '..', 'src', 'theme')

writeFileSync(resolve(themeDir, 'theme.css'), generateThemeCss())
writeFileSync(resolve(themeDir, 'tokens.ts'), generateTokensTs())

console.log('Generated theme.css + tokens.ts from @chroxy/design-tokens')
