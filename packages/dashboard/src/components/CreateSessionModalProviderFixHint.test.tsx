/**
 * Tests for the richer fix-hint affordance on the Create Session modal when
 * the selected provider is unready (#4340).
 *
 * Pre-#4340 the disabled `<option>` carried the full hint inline ("Codex
 * (CLI) — set OPENAI_API_KEY or run `codex login`"). That worked for short
 * hints but:
 *   - native `<select>` rendering truncated long labels on some browser/OS
 *     combos
 *   - backticks rendered as literal characters, not `<code>` formatting
 *   - `title=` tooltip only fired on hover (no touch support)
 *
 * #4340 moves the hint to an inline help panel below the dropdown that
 * renders ONLY when the selected provider's auth.ready is false. The panel:
 *   - exposes the full hint with backtick-wrapped tokens promoted to `<code>`
 *   - is keyed under `data-testid="provider-fix-hint"` for assertions
 *   - is warning-toned so it stands apart from the billing-hint
 *   - keeps the existing `title=` hover affordance intact for desktop users
 *   - keeps `<option>` text short (provider name + "(unavailable)" suffix)
 *     so native rendering doesn't truncate it
 *
 * Pins:
 *   1. selected-unready-shows-panel — when defaultProvider is unready, the
 *      fix-hint panel renders with the full auth.hint text on first mount
 *   2. selected-ready-no-panel — when the selected provider is ready, the
 *      panel does not render
 *   3. backticks-render-as-code — backtick-wrapped tokens in the hint are
 *      promoted to `<code>` elements so `codex login` formats as code
 *   4. option-label-stays-short — disabled options use the "(unavailable)"
 *      suffix instead of inlining the full hint
 *   5. switching-to-unready-shows-panel — selecting an unready provider via
 *      the dropdown surfaces the panel for that provider
 *   6. create-disabled-for-unready — the Create button must refuse to
 *      submit while an unready provider is selected (defence in depth)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'

const mockStoreState: Record<string, unknown> = {}

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockStoreState),
}))

import { CreateSessionModal, type CreateSessionModalProps } from './CreateSessionModal'

const SDK_READY = {
  name: 'claude-sdk',
  capabilities: {},
  auth: { ready: true, source: 'env', envVar: 'ANTHROPIC_API_KEY', envVars: ['ANTHROPIC_API_KEY'], detail: 'API key (env ANTHROPIC_API_KEY)', hint: '' },
}
const CODEX_UNREADY = {
  name: 'codex',
  capabilities: {},
  auth: {
    ready: false,
    source: 'none',
    envVar: null,
    envVars: ['OPENAI_API_KEY'],
    detail: 'Not configured — set OPENAI_API_KEY or run `codex login`',
    hint: 'set OPENAI_API_KEY or run `codex login`',
  },
}
const GEMINI_UNREADY = {
  name: 'gemini',
  capabilities: {},
  auth: {
    ready: false,
    source: 'none',
    envVar: null,
    envVars: ['GEMINI_API_KEY'],
    detail: 'Not configured — set GEMINI_API_KEY or run `gemini login`',
    hint: 'set GEMINI_API_KEY or run `gemini login`',
  },
}

beforeEach(() => {
  for (const k of Object.keys(mockStoreState)) delete mockStoreState[k]
  Object.assign(mockStoreState, {
    defaultProvider: 'claude-sdk',
    defaultModel: null,
    availableModels: [],
    availableModelsProvider: null,
    availableProviders: [SDK_READY, CODEX_UNREADY, GEMINI_UNREADY],
    availablePermissionModes: [],
    environments: [],
    requestDirectoryListing: () => {},
    setDirectoryListingCallback: () => {},
    defaultCwd: null,
  })
})

afterEach(cleanup)

function renderModal(props: Partial<CreateSessionModalProps> = {}) {
  const onCreate = vi.fn()
  const onClose = vi.fn()
  const defaultProps: CreateSessionModalProps = {
    open: true,
    onClose,
    onCreate,
    initialCwd: '/Users/me/projects',
    knownCwds: [],
    existingNames: [],
    ...props,
  }
  return { ...render(<CreateSessionModal {...defaultProps} />), onCreate }
}

describe('CreateSessionModal provider fix-hint panel (#4340)', () => {
  it('renders the fix-hint panel when the selected provider is unready', () => {
    // Default to an unready provider so the panel surfaces on first mount.
    mockStoreState.defaultProvider = 'codex'
    renderModal()
    const panel = screen.getByTestId('provider-fix-hint')
    expect(panel).toBeInTheDocument()
    expect(panel.textContent).toMatch(/set OPENAI_API_KEY/)
    expect(panel.textContent).toMatch(/codex login/)
  })

  it('does NOT render the fix-hint panel when the selected provider is ready', () => {
    mockStoreState.defaultProvider = 'claude-sdk'
    renderModal()
    expect(screen.queryByTestId('provider-fix-hint')).not.toBeInTheDocument()
  })

  it('promotes backtick-wrapped tokens in the hint to <code> elements', () => {
    mockStoreState.defaultProvider = 'codex'
    renderModal()
    const panel = screen.getByTestId('provider-fix-hint')
    // The hint contains `codex login` — that token must be a <code> child,
    // not a literal backtick run in the text. The server-provided hint
    // string from providers.js only wraps the CLI command in backticks
    // (env-var names are left bare), so we just pin the command token.
    expect(panel.textContent).not.toMatch(/`codex login`/)
    const codeNodes = panel.querySelectorAll('code')
    const codeTexts = Array.from(codeNodes).map(n => n.textContent)
    expect(codeTexts).toContain('codex login')
  })

  it('renders an unmatched trailing backtick as literal text (helper robustness)', () => {
    // Defensive: if the server ever ships a malformed hint with an
    // unbalanced backtick, the panel must still render rather than throw
    // or eat the rest of the string. Exercise the helper via a fixture
    // with an unmatched backtick.
    const MALFORMED = {
      ...CODEX_UNREADY,
      auth: {
        ...CODEX_UNREADY.auth,
        hint: 'set OPENAI_API_KEY or run `codex login (oops unmatched',
        detail: 'Not configured — see hint',
      },
    }
    mockStoreState.availableProviders = [SDK_READY, MALFORMED]
    mockStoreState.defaultProvider = 'codex'
    renderModal()
    const panel = screen.getByTestId('provider-fix-hint')
    expect(panel.textContent).toMatch(/codex login \(oops unmatched/)
  })

  it('keeps the <option> label short by using the "(unavailable)" suffix', () => {
    renderModal()
    const select = screen.getByLabelText('Select provider') as HTMLSelectElement
    const codexOption = Array.from(select.options).find(o => o.value === 'codex')
    expect(codexOption).toBeTruthy()
    // The label must mark unavailability but NOT inline the full hint —
    // otherwise we're back to the pre-#4340 wall of text.
    expect(codexOption!.textContent).toMatch(/unavailable/i)
    expect(codexOption!.textContent).not.toMatch(/OPENAI_API_KEY/)
    expect(codexOption!.textContent).not.toMatch(/codex login/)
  })

  it('updates the fix-hint panel when the user switches providers in the dropdown', () => {
    // Start on a ready provider — no panel.
    mockStoreState.defaultProvider = 'claude-sdk'
    renderModal()
    expect(screen.queryByTestId('provider-fix-hint')).not.toBeInTheDocument()
    // Switch to an unready provider — panel appears with that provider's hint.
    const select = screen.getByLabelText('Select provider') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'gemini' } })
    const panel = screen.getByTestId('provider-fix-hint')
    expect(panel.textContent).toMatch(/GEMINI_API_KEY/)
    expect(panel.textContent).toMatch(/gemini login/)
  })

  it('refuses to submit when the selected provider is unready', () => {
    mockStoreState.defaultProvider = 'codex'
    const { onCreate } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).not.toHaveBeenCalled()
  })
})
