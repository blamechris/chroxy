import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, './InputBar.tsx'),
  'utf-8',
)

describe('InputBar busy/thinking state', () => {
  test('has isBusy prop in interface', () => {
    expect(src).toMatch(/isBusy\??\s*:\s*boolean/)
  })

  test('shows thinking indicator when busy but not streaming', () => {
    // Should render a "thinking" element when isBusy && !isStreaming
    expect(src).toMatch(/isBusy[\s\S]*?thinking|thinking[\s\S]*?isBusy/)
  })

  test('textarea is enabled when busy (allows follow-up input)', () => {
    // textarea should NOT be disabled by isBusy — users can type follow-ups (#2631)
    // disabled should only check the `disabled` prop (connection state), not isBusy
    expect(src).toMatch(/disabled=\{disabled\}/)
  })

  test('shows stop button when streaming (existing behavior)', () => {
    expect(src).toMatch(/isStreaming[\s\S]*?Stop/)
  })
})
