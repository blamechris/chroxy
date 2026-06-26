/**
 * @chroxy/design-tokens — canonical token map + generators
 * (chat redesign epic #6389, Phase 0 #6390).
 *
 * The dashboard's `theme.css` and `theme/tokens.ts` are GENERATED from
 * `tokens-data.js` here (pipeline inverted from the old theme.css → tokens.ts
 * direction). `generateThemeCss()` / `generateTokensTs()` are pure string
 * builders; the dashboard's `scripts/generate-theme-tokens.mjs` writes them to
 * disk. The structural-token grouping below MUST keep `colors` / `spacing` /
 * `typography` / `fonts` byte-shape-compatible with the existing generated
 * tokens.ts (the only change there is appended new groups), since
 * `packages/dashboard/src/theme/index.ts` re-exports those four.
 */

import { TOKEN_GROUPS, ALL_TOKENS } from './tokens-data.js'

export { TOKEN_GROUPS, ALL_TOKENS }

// Color CSS-var prefixes → the `colors` sub-object key in tokens.ts. Mirrors
// the categorisation the old generate-theme-tokens.mjs applied when parsing CSS.
const COLOR_SUBS = ['bg', 'text', 'accent', 'border', 'banner', 'warning', 'status', 'syntax', 'diff', 'scrollbar']

function toCamelCase(str) {
  return str.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

/** Bucket every token into the tokens.ts export shape. Throws on an
 *  unrecognised token so a new prefix can't silently vanish. */
function categorize() {
  const g = {
    colors: {},
    spacing: {},
    typography: {},
    fonts: {},
    leading: {},
    radii: {},
    motion: { durations: {}, easings: {}, loops: {} },
  }
  for (const [name, value] of ALL_TOKENS) {
    // Typography px sizes: --text-xs … --text-lg, plus the new --text-chat.
    if (name.startsWith('text-') && value.endsWith('px')) {
      g.typography[toCamelCase(name.slice('text-'.length))] = parseInt(value, 10)
      continue
    }
    if (name.startsWith('leading-')) {
      g.leading[toCamelCase(name.slice('leading-'.length))] = parseFloat(value)
      continue
    }
    if (name.startsWith('radius-')) {
      g.radii[toCamelCase(name.slice('radius-'.length))] = parseInt(value, 10)
      continue
    }
    if (name.startsWith('dur-')) {
      g.motion.durations[toCamelCase(name.slice('dur-'.length))] = parseInt(value, 10)
      continue
    }
    if (name.startsWith('ease-')) {
      g.motion.easings[toCamelCase(name.slice('ease-'.length))] = value
      continue
    }
    if (/^(rail|caret|waiting)-/.test(name)) {
      g.motion.loops[toCamelCase(name)] = parseInt(value, 10)
      continue
    }
    let matched = false
    for (const sub of COLOR_SUBS) {
      if (name.startsWith(sub + '-')) {
        if (!g.colors[sub]) g.colors[sub] = {}
        g.colors[sub][toCamelCase(name.slice(sub.length + 1))] = value
        matched = true
        break
      }
    }
    if (matched) continue
    if (name.startsWith('font-')) {
      g.fonts[toCamelCase(name.slice('font-'.length))] = value
      continue
    }
    if (name.startsWith('space-')) {
      g.spacing[toCamelCase(name.slice('space-'.length))] = parseInt(value, 10)
      continue
    }
    throw new Error(`[design-tokens] unmapped token --${name}`)
  }
  return g
}

// Identical rendering contract to the old generate-theme-tokens.mjs:
// numbers bare, strings single-quoted unless they contain a single quote
// (font stacks), nested objects recursed.
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
      lines.push(`${pad}${key}: "${val}",`)
    } else {
      lines.push(`${pad}${key}: '${val}',`)
    }
  }
  return lines.join('\n')
}

const GENERATED_HEADER = `/**
 * DO NOT EDIT — generated from @chroxy/design-tokens by
 * scripts/generate-theme-tokens.mjs.
 *
 * Edit tokens in packages/design-tokens/src/tokens-data.js, then run
 * \`npm run generate-tokens\` in packages/dashboard.
 */`

/** Build the dashboard's `theme.css` (`:root` custom properties) from the
 *  canonical map, with one section comment per token group. */
export function generateThemeCss() {
  const lines = [
    '/* DO NOT EDIT — generated from @chroxy/design-tokens by',
    ' * scripts/generate-theme-tokens.mjs. Edit tokens in',
    ' * packages/design-tokens/src/tokens-data.js, then run',
    ' * `npm run generate-tokens` in packages/dashboard. */',
    '',
    ':root {',
  ]
  TOKEN_GROUPS.forEach((group, i) => {
    if (i > 0) lines.push('')
    lines.push(`  /* ${group.title} */`)
    for (const [name, value] of group.vars) lines.push(`  --${name}: ${value};`)
  })
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

/** Build the dashboard's `theme/tokens.ts` from the canonical map. The
 *  `colors`/`spacing`/`typography`/`fonts` exports keep their existing shape;
 *  `leading`/`radii`/`motion` are the new structural additions. */
export function generateTokensTs() {
  const g = categorize()
  const block = (name, obj) => `export const ${name} = {\n${renderObject(obj)}\n} as const`
  return [
    GENERATED_HEADER,
    '',
    block('colors', g.colors),
    '',
    block('spacing', g.spacing),
    '',
    block('typography', g.typography),
    '',
    block('fonts', g.fonts),
    '',
    block('leading', g.leading),
    '',
    block('radii', g.radii),
    '',
    block('motion', g.motion),
    '',
  ].join('\n')
}
