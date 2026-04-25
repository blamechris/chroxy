/**
 * Theme system tests (#1095)
 *
 * Verifies CSS custom properties, TypeScript tokens, typography scale,
 * and spacing system are properly defined and consistent.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  colors,
  spacing,
  typography,
  fonts,
} from './tokens'

// ---------------------------------------------------------------------------
// Helper: load and inject theme.css into jsdom
// ---------------------------------------------------------------------------
function loadThemeCSS(): CSSStyleDeclaration {
  const cssPath = resolve(__dirname, 'theme.css')
  const css = readFileSync(cssPath, 'utf-8')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  return getComputedStyle(document.documentElement)
}

let computed: CSSStyleDeclaration

beforeAll(() => {
  computed = loadThemeCSS()
})

// ---------------------------------------------------------------------------
// CSS Custom Properties — Background colors
// ---------------------------------------------------------------------------
describe('CSS custom properties — backgrounds', () => {
  it('defines --bg-primary', () => {
    expect(computed.getPropertyValue('--bg-primary').trim()).toBe('#0f0f1a')
  })

  it('defines --bg-secondary', () => {
    expect(computed.getPropertyValue('--bg-secondary').trim()).toBe('#1a1a2e')
  })

  it('defines --bg-tertiary', () => {
    expect(computed.getPropertyValue('--bg-tertiary').trim()).toBe('#16162a')
  })

  it('defines --bg-card', () => {
    expect(computed.getPropertyValue('--bg-card').trim()).toBe('#2a2a4e')
  })

  it('defines --bg-input', () => {
    expect(computed.getPropertyValue('--bg-input').trim()).toBe('#0f0f1a')
  })

  it('defines --bg-terminal', () => {
    expect(computed.getPropertyValue('--bg-terminal').trim()).toBe('#000000')
  })
})

// ---------------------------------------------------------------------------
// CSS Custom Properties — Text colors
// ---------------------------------------------------------------------------
describe('CSS custom properties — text', () => {
  it('defines --text-primary', () => {
    expect(computed.getPropertyValue('--text-primary').trim()).toBe('#ffffff')
  })

  it('defines --text-secondary', () => {
    expect(computed.getPropertyValue('--text-secondary').trim()).toBe('#cccccc')
  })

  it('defines --text-muted', () => {
    expect(computed.getPropertyValue('--text-muted').trim()).toBe('#888888')
  })

  it('defines --text-dim', () => {
    expect(computed.getPropertyValue('--text-dim').trim()).toBe('#666666')
  })
})

// ---------------------------------------------------------------------------
// CSS Custom Properties — Accent colors
// ---------------------------------------------------------------------------
describe('CSS custom properties — accents', () => {
  it('defines --accent-blue', () => {
    expect(computed.getPropertyValue('--accent-blue').trim()).toBe('#4a9eff')
  })

  it('defines --accent-green', () => {
    expect(computed.getPropertyValue('--accent-green').trim()).toBe('#22c55e')
  })

  it('defines --accent-purple', () => {
    expect(computed.getPropertyValue('--accent-purple').trim()).toBe('#a78bfa')
  })

  it('defines --accent-orange', () => {
    expect(computed.getPropertyValue('--accent-orange').trim()).toBe('#f59e0b')
  })

  it('defines --accent-red', () => {
    expect(computed.getPropertyValue('--accent-red').trim()).toBe('#ff4a4a')
  })
})

// ---------------------------------------------------------------------------
// CSS Custom Properties — Border colors
// ---------------------------------------------------------------------------
describe('CSS custom properties — borders', () => {
  it('defines --border-primary', () => {
    expect(computed.getPropertyValue('--border-primary').trim()).toBe('#2a2a4e')
  })

  it('defines --border-secondary', () => {
    expect(computed.getPropertyValue('--border-secondary').trim()).toBe('#3a3a5e')
  })

  it('defines --border-subtle', () => {
    expect(computed.getPropertyValue('--border-subtle').trim()).toBe('#4a4a6e')
  })
})

// ---------------------------------------------------------------------------
// CSS Custom Properties — Fonts
// ---------------------------------------------------------------------------
describe('CSS custom properties — fonts', () => {
  it('defines --font-mono', () => {
    const value = computed.getPropertyValue('--font-mono').trim()
    expect(value).toContain('monospace')
  })

  it('defines --font-ui', () => {
    const value = computed.getPropertyValue('--font-ui').trim()
    expect(value).toContain('system-ui')
  })
})

// ---------------------------------------------------------------------------
// CSS Custom Properties — Typography scale
// ---------------------------------------------------------------------------
describe('CSS custom properties — typography', () => {
  it('defines --text-xs (10px)', () => {
    expect(computed.getPropertyValue('--text-xs').trim()).toBe('10px')
  })

  it('defines --text-sm (12px)', () => {
    expect(computed.getPropertyValue('--text-sm').trim()).toBe('12px')
  })

  it('defines --text-base (13px)', () => {
    expect(computed.getPropertyValue('--text-base').trim()).toBe('13px')
  })

  it('defines --text-md (14px)', () => {
    expect(computed.getPropertyValue('--text-md').trim()).toBe('14px')
  })

  it('defines --text-lg (16px)', () => {
    expect(computed.getPropertyValue('--text-lg').trim()).toBe('16px')
  })
})

// ---------------------------------------------------------------------------
// CSS Custom Properties — Spacing scale
// ---------------------------------------------------------------------------
describe('CSS custom properties — spacing', () => {
  it('defines 4px base grid spacing', () => {
    expect(computed.getPropertyValue('--space-1').trim()).toBe('4px')
    expect(computed.getPropertyValue('--space-2').trim()).toBe('8px')
    expect(computed.getPropertyValue('--space-3').trim()).toBe('12px')
    expect(computed.getPropertyValue('--space-4').trim()).toBe('16px')
    expect(computed.getPropertyValue('--space-6').trim()).toBe('24px')
    expect(computed.getPropertyValue('--space-8').trim()).toBe('32px')
  })
})

// ---------------------------------------------------------------------------
// TypeScript tokens — consistency with CSS
// ---------------------------------------------------------------------------
describe('TypeScript tokens', () => {
  it('colors.bg matches CSS values', () => {
    expect(colors.bg.primary).toBe('#0f0f1a')
    expect(colors.bg.secondary).toBe('#1a1a2e')
    expect(colors.bg.tertiary).toBe('#16162a')
    expect(colors.bg.card).toBe('#2a2a4e')
    expect(colors.bg.input).toBe('#0f0f1a')
    expect(colors.bg.terminal).toBe('#000000')
  })

  it('colors.text matches CSS values', () => {
    expect(colors.text.primary).toBe('#ffffff')
    expect(colors.text.secondary).toBe('#cccccc')
    expect(colors.text.muted).toBe('#888888')
    expect(colors.text.dim).toBe('#666666')
  })

  it('colors.accent matches CSS values', () => {
    expect(colors.accent.blue).toBe('#4a9eff')
    expect(colors.accent.green).toBe('#22c55e')
    expect(colors.accent.purple).toBe('#a78bfa')
    expect(colors.accent.orange).toBe('#f59e0b')
    expect(colors.accent.red).toBe('#ff4a4a')
  })

  it('colors.border matches CSS values', () => {
    expect(colors.border.primary).toBe('#2a2a4e')
    expect(colors.border.secondary).toBe('#3a3a5e')
    expect(colors.border.subtle).toBe('#4a4a6e')
  })

  it('colors.syntax has highlight colors', () => {
    expect(colors.syntax.keyword).toBe('#c4a5ff')
    expect(colors.syntax.string).toBe('#4eca6a')
    expect(colors.syntax.comment).toBe('#7a7a7a')
    expect(colors.syntax.number).toBe('#ff9a52')
    expect(colors.syntax.function).toBe('#4a9eff')
  })

  it('spacing follows 4px base grid', () => {
    expect(spacing[1]).toBe(4)
    expect(spacing[2]).toBe(8)
    expect(spacing[3]).toBe(12)
    expect(spacing[4]).toBe(16)
    expect(spacing[6]).toBe(24)
    expect(spacing[8]).toBe(32)
  })

  it('typography has expected font sizes', () => {
    expect(typography.xs).toBe(10)
    expect(typography.sm).toBe(12)
    expect(typography.base).toBe(13)
    expect(typography.md).toBe(14)
    expect(typography.lg).toBe(16)
  })

  it('fonts has mono and ui families', () => {
    expect(fonts.mono).toContain('monospace')
    expect(fonts.ui).toContain('system-ui')
  })
})

// ---------------------------------------------------------------------------
// CSS Custom Properties — Warning + banner tokens (#2886)
// ---------------------------------------------------------------------------
describe('CSS custom properties — warning + banner', () => {
  it('defines --warning-fg', () => {
    expect(computed.getPropertyValue('--warning-fg').trim()).toBe('#fbbf24')
  })

  it('defines --warning-bg-subtle', () => {
    expect(computed.getPropertyValue('--warning-bg-subtle').trim()).toBe('#fbbf2422')
  })

  it('defines --banner-border-subtle', () => {
    expect(computed.getPropertyValue('--banner-border-subtle').trim()).toBe('#252540')
  })

  it('CSS and TypeScript token values stay in sync', () => {
    // Prevents drift between theme.css and tokens.ts (regenerated via generate-theme-tokens.mjs)
    expect(colors.warning.fg).toBe(computed.getPropertyValue('--warning-fg').trim())
    expect(colors.warning.bgSubtle).toBe(computed.getPropertyValue('--warning-bg-subtle').trim())
    expect(colors.banner.borderSubtle).toBe(computed.getPropertyValue('--banner-border-subtle').trim())
  })
})

// ---------------------------------------------------------------------------
// Extended color tokens
// ---------------------------------------------------------------------------
describe('extended color tokens', () => {
  it('has UI-specific background colors', () => {
    expect(colors.bg.header).toBe('#151528')
    expect(colors.bg.sessionBar).toBe('#12121f')
    expect(colors.bg.codeBlock).toBe('#0a0a18')
  })

  it('has status colors', () => {
    expect(colors.status.connected).toBe('#22c55e')
    expect(colors.status.disconnected).toBe('#ef4444')
    expect(colors.status.connecting).toBe('#eab308')
  })

  it('has diff colors', () => {
    expect(colors.diff.addBg).toBe('#1a2e1a')
    expect(colors.diff.removeBg).toBe('#2e1a1a')
    expect(colors.diff.addText).toBe('#4eca6a')
    expect(colors.diff.removeText).toBe('#ff5b5b')
  })

  it('has accent opacity variants', () => {
    expect(colors.accent.blueLight).toBe('#4a9eff22')
    expect(colors.accent.blueSubtle).toBe('#4a9eff33')
    expect(colors.accent.greenLight).toBe('#22c55e22')
    expect(colors.accent.purpleLight).toBe('#a78bfa22')
    expect(colors.accent.orangeLight).toBe('#f59e0b11')
    expect(colors.accent.redLight).toBe('#ff4a4a11')
  })
})

// ---------------------------------------------------------------------------
// components.css — prefers-reduced-motion coverage (#2941)
// ---------------------------------------------------------------------------
describe('components.css reduced-motion overrides', () => {
  it('disables .tunnel-warming-banner transition under prefers-reduced-motion: reduce', () => {
    const cssPath = resolve(__dirname, 'components.css')
    const css = readFileSync(cssPath, 'utf-8')

    // Locate the prefers-reduced-motion: reduce blocks
    const reduceBlocks: string[] = []
    const mediaRe = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g
    let match: RegExpExecArray | null
    while ((match = mediaRe.exec(css)) !== null) {
      // Extract content between the opening brace and the matching closing brace
      let depth = 1
      let i = match.index + match[0].length
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++
        else if (css[i] === '}') depth--
        i++
      }
      reduceBlocks.push(css.slice(match.index, i))
    }

    expect(reduceBlocks.length).toBeGreaterThan(0)

    const bannerOverridePresent = reduceBlocks.some(
      (block) =>
        block.includes('.tunnel-warming-banner') && block.includes('transition: none'),
    )
    expect(bannerOverridePresent).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Global CSS — existence check
// ---------------------------------------------------------------------------
describe('global.css', () => {
  it('exists and contains reset styles', () => {
    const cssPath = resolve(__dirname, 'global.css')
    const css = readFileSync(cssPath, 'utf-8')
    expect(css).toContain('box-sizing: border-box')
    expect(css).toContain('margin: 0')
  })

  it('contains scrollbar styles', () => {
    const cssPath = resolve(__dirname, 'global.css')
    const css = readFileSync(cssPath, 'utf-8')
    expect(css).toContain('scrollbar')
  })

  it('contains animation keyframes', () => {
    const cssPath = resolve(__dirname, 'global.css')
    const css = readFileSync(cssPath, 'utf-8')
    expect(css).toContain('@keyframes')
  })
})
