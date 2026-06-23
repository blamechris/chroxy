/**
 * useChatKeyboard (#6287) — a SINGLE document-level keyboard listener for the
 * permission shortcuts, scoped to the FIRST unanswered permission prompt in the
 * active session.
 *
 * Before this, every mounted `<PermissionPrompt>` registered its own `keydown`
 * listener (PermissionPrompt.tsx). With more than one live prompt at once
 * (usePermissionAnnouncer can surface several), Cmd+Y / Cmd+Shift+Y / Escape
 * fired on EVERY mounted prompt simultaneously — a single keystroke answered
 * (allowed or denied) every pending request, a security hazard. Hoisting to one
 * listener that targets only the visible primary prompt fixes the fan-out:
 * answering the primary advances "first unanswered" to the next, so the operator
 * walks the queue one keystroke at a time.
 *
 * The existing guards are preserved: skip when focus is in an INPUT/TEXTAREA/
 * SELECT, skip Escape when a modal overlay (`[data-modal-overlay]`) is open, and
 * only act while connected (sendPermissionResponse refuses to send while the
 * socket is down, so we never optimistically resolve a prompt the server can't
 * receive — #5699).
 */
import { useEffect, useMemo, useRef } from 'react'
import type { ChatMessage } from '@chroxy/store-core'
import { isRuleEligibleTool, isRuleEligibleProvider } from '../store/connection'
import type { PermissionDecision, ProviderInfo } from '../store/types'

export interface UseChatKeyboardArgs {
  /** The active session's messages, in render order. */
  storeMessages: ChatMessage[]
  /** Cross-client permission decisions keyed by requestId. */
  resolvedPermissions: Record<string, PermissionDecision> | undefined
  /** The single choke point that sends the answer (App's respondToPermission). */
  sendPermissionResponse: (requestId: string, decision: PermissionDecision) => unknown
  /** Active session provider, used to gate 'allowSession' on rule support. */
  activeSessionProvider: string | null
  /** Registered providers, used to resolve `isRuleEligibleProvider`. */
  availableProviders: ProviderInfo[]
  /** Whether the socket is connected — shortcuts no-op while disconnected. */
  connected: boolean
}

/**
 * The first unanswered permission prompt in the active session — the SAME
 * predicate the renderer uses to decide whether to mount an interactive
 * `<PermissionPrompt>` (`requestId && expiresAt && !answered`), plus the
 * cross-client `resolvedPermissions` check so a prompt another client already
 * answered is skipped.
 */
function findPrimaryPermissionPrompt(
  storeMessages: ChatMessage[],
  resolvedPermissions: Record<string, PermissionDecision> | undefined,
): { requestId: string; tool: string } | null {
  for (const m of storeMessages) {
    if (!m.requestId || !m.expiresAt || m.answered) continue
    if (resolvedPermissions?.[m.requestId]) continue
    return { requestId: m.requestId, tool: m.tool || 'Unknown' }
  }
  return null
}

export function useChatKeyboard(args: UseChatKeyboardArgs): void {
  const {
    storeMessages,
    resolvedPermissions,
    sendPermissionResponse,
    activeSessionProvider,
    availableProviders,
    connected,
  } = args

  const primary = useMemo(
    () => findPrimaryPermissionPrompt(storeMessages, resolvedPermissions),
    [storeMessages, resolvedPermissions],
  )
  const providerSupportsRules = isRuleEligibleProvider(activeSessionProvider, availableProviders)

  // Mirror the keys we depend on into refs so the listener reads fresh values
  // without re-binding on every render (storeMessages re-references on each
  // streaming delta). One stable listener for the component's lifetime.
  const stateRef = useRef({ primary, providerSupportsRules, connected, sendPermissionResponse })
  stateRef.current = { primary, providerSupportsRules, connected, sendPermissionResponse }

  // #6287 — guard against double-fire from key auto-repeat before the store's
  // answered state flips and `primary` advances. Latched per requestId; cleared
  // whenever the primary prompt changes (a new one became first-unanswered).
  const submittedRef = useRef<string | null>(null)
  useEffect(() => {
    submittedRef.current = null
  }, [primary?.requestId])

  useEffect(() => {
    const respond = (decision: PermissionDecision) => {
      const { primary: cur, providerSupportsRules: rules, connected: live, sendPermissionResponse: send } = stateRef.current
      if (!cur || !live) return
      if (submittedRef.current === cur.requestId) return
      // Coerce 'allowSession' to plain 'allow' when the tool/provider can't take a
      // session rule — mirrors PermissionPrompt.respond so keyboard users on an
      // ineligible prompt still get an Allow-equivalent decision (#2834/#3072).
      const allowSessionOk = isRuleEligibleTool(cur.tool) && rules
      const effective: PermissionDecision =
        decision === 'allowSession' && !allowSessionOk ? 'allow' : decision
      submittedRef.current = cur.requestId
      send(cur.requestId, effective)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip when focus is in an input, textarea, or select.
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key.toLowerCase() === 'y' && (e.metaKey || e.ctrlKey)) {
        // Only act if there IS a primary prompt to answer.
        if (!stateRef.current.primary) return
        e.preventDefault()
        if (e.shiftKey) {
          // Allow for Session — no-op when the tool/provider doesn't support
          // session rules (#2834/#3072), matching the button's gating.
          const cur = stateRef.current.primary
          if (cur && isRuleEligibleTool(cur.tool) && stateRef.current.providerSupportsRules) {
            respond('allowSession')
          }
        } else {
          respond('allow')
        }
      } else if (e.key === 'Escape') {
        if (!stateRef.current.primary) return
        // Skip if a modal overlay is open — let the Modal handle Escape (#1230).
        if (document.querySelector('[data-modal-overlay]')) return
        respond('deny')
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])
}
