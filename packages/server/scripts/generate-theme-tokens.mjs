#!/usr/bin/env node

/**
 * Generate TypeScript theme tokens from CSS custom properties.
 *
 * Source of truth: src/dashboard-next/src/theme/theme.css
 * Output:         src/dashboard-next/src/theme/tokens.ts
 *
 * Usage: node scripts/generate-theme-tokens.mjs
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cssPath = resolve(__dirname, '..', 'src', 'dashboard-next', 'src', 'theme', 'theme.css')
const outPath = resolve(__dirname, '..', 'src', 'dashboard-next', 'src', 'theme', 'tokens.ts')

// Parse CSS custom properties from :root block
const css = readFileSync(cssPath, 'utf-8')
const rootMatch = css.match(/:root\s*\{([^}]+)\}/)
if (!rootMatch) {
  console.error('Could not find :root block in theme.css')
  process.exit(1)
}

const props = []
for (const line of rootMatch[1].split('\n')) {
  const match = line.match(/^\s*--([\w-]+):\s*(.+?)\s*;/)
  if (match) {
    props.push({ name: match[1], value: match[2] })
  }
}

// Category mapping: CSS prefix → TS group
const categories = {
  bg: { group: 'colors', sub: 'bg' },
  text: { group: 'colors', sub: 'text' },
  accent: { group: 'colors', sub: 'accent' },
  border: { group: 'colors', sub: 'border' },
  status: { group: 'colors', sub: 'status' },
  syntax: { group: 'colors', sub: 'syntax' },
  diff: { group: 'colors', sub: 'diff' },
  scrollbar: { group: 'colors', sub: 'scrollbar' },
  font: { group: 'fonts', sub: null },
  space: { group: 'spacing', sub: null },
}

// Convert kebab-case to camelCase
function toCamelCase(str) {
  return str.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

// Classify and group each property
const groups = { colors: {}, spacing: {}, typography: {}, fonts: {} }
const unmapped = []

for (const { name, value } of props) {
  // Typography scale: --text-xs, --text-sm, etc. (px values, not color hex)
  if (name.startsWith('text-') && value.endsWith('px')) {
    const key = name.replace('text-', '')
    groups.typography[key] = parseInt(value, 10)
    continue
  }

  // Find matching category by prefix
  let matched = false
  for (const [prefix, { group, sub }] of Object.entries(categories)) {
    if (name.startsWith(prefix + '-')) {
      const key = toCamelCase(name.slice(prefix.length + 1))
      if (group === 'colors') {
        if (!groups.colors[sub]) groups.colors[sub] = {}
        groups.colors[sub][key] = value
      } else if (group === 'spacing') {
        // --space-1 → spacing[1] = 4
        groups.spacing[key] = parseInt(value, 10)
      } else if (group === 'fonts') {
        groups.fonts[key] = value
      }
      matched = true
      break
    }
  }

  if (!matched) {
    unmapped.push(`--${name}: ${value}`)
  }
}

if (unmapped.length > 0) {
  console.error(`[error] ${unmapped.length} unmapped CSS properties:`)
  for (const prop of unmapped) console.error(`  ${prop}`)
  process.exit(1)
}

// Generate TypeScript output
function renderObject(obj, indent = 2) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'object' && val !== null) {
      lines.push(`${pad}${key}: {`)
      lines.push(renderObject(val, indent + 2))
      lines.push(`${pad}},`)
    } else if (typeof val === 'number') {
      lines.push(`${pad}${key}: ${val},`)
    } else if (typeof val === 'string' && val.includes("'")) {
      // Use double quotes for values containing single quotes (font stacks)
      lines.push(`${pad}${key}: "${val}",`)
    } else {
      lines.push(`${pad}${key}: '${val}',`)
    }
  }
  return lines.join('\n')
}

const output = `/**
 * DO NOT EDIT — generated from theme.css by scripts/generate-theme-tokens.mjs
 *
 * Design tokens for the Chroxy desktop dashboard.
 * Run: npm run dashboard:generate-tokens
 */

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export const colors = {
${renderObject(groups.colors)}
} as const

// ---------------------------------------------------------------------------
// Spacing — 4px base grid
// ---------------------------------------------------------------------------

export const spacing = {
${renderObject(groups.spacing)}
} as const

// ---------------------------------------------------------------------------
// Typography — font sizes in px
// ---------------------------------------------------------------------------

export const typography = {
${renderObject(groups.typography)}
} as const

// ---------------------------------------------------------------------------
// Font stacks
// ---------------------------------------------------------------------------

export const fonts = {
${renderObject(groups.fonts)}
} as const
`

writeFileSync(outPath, output)
console.log(`Generated ${outPath} from ${cssPath}`)
console.log(`  Colors: ${Object.values(groups.colors).reduce((n, g) => n + Object.keys(g).length, 0)} tokens`)
console.log(`  Spacing: ${Object.keys(groups.spacing).length} tokens`)
console.log(`  Typography: ${Object.keys(groups.typography).length} tokens`)
console.log(`  Fonts: ${Object.keys(groups.fonts).length} tokens`)
