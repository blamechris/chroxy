/**
 * InputBar — auto-expanding textarea with send/interrupt and slash command picker.
 *
 * Enter for newline, Cmd/Ctrl+Enter to send, Escape to interrupt.
 * Supports file picker (@ trigger), attachment chips, slash command picker (/ trigger),
 * image paste/drag-drop (#1288), and image preview thumbnails (#1289).
 */
import { useState, useEffect, useMemo, useId, useRef, useCallback, type KeyboardEvent, type ChangeEvent, type ClipboardEvent, type DragEvent, type UIEvent } from 'react'
import { FilePicker, type FilePickerItem } from './FilePicker'
import { AttachmentChip } from './AttachmentChip'
import { SlashCommandPicker } from './SlashCommandPicker'
import { ImageThumbnail } from './ImageThumbnail'
import type { SlashCommand, EvaluatorResultPayload } from '../store/types'
import { filterImageFiles } from '../utils/image-utils'
import { shouldCollapsePaste, findActiveMarkerIds } from '@chroxy/store-core'
import { PastedTextChip } from './PastedTextChip'
import { tokenizeThinkingKeywords } from './thinking-keyword-tokens'

/**
 * Convert a clipboard HTML payload to plain text. Used as a fallback when
 * a paste source (e.g. rendered markdown in WKWebView) only populates
 * `text/html` and leaves `text/plain` empty, which otherwise causes the
 * large-paste collapse path in handlePaste to skip the paste entirely.
 *
 * DOMParser handles entity decoding and tag stripping correctly; the
 * `<br>` / block-level normalisation keeps line counts close to the
 * visual original so the line-count threshold still triggers.
 */
function htmlToPlainText(html: string): string {
  if (!html) return ''
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // Replace <br> with newlines and append a newline after block-level
    // close tags so visible line structure survives the strip.
    doc.querySelectorAll('br').forEach(el => el.replaceWith('\n'))
    const blockTags = 'p, div, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote'
    doc.querySelectorAll(blockTags).forEach(el => el.append('\n'))
    // #3842 — preserve leading whitespace (indented code blocks, YAML inside
    // `<pre>`, etc.). The block-tag normalisation above appends `\n` after
    // every block close, so a single trailing newline is an artefact worth
    // dropping; leading whitespace and interior whitespace must be left
    // intact because the collapsed-paste path sends this text verbatim.
    const out = doc.body.textContent ?? ''
    return out.endsWith('\n') ? out.slice(0, -1) : out
  } catch {
    return ''
  }
}

export interface FileAttachment {
  path: string
  name: string
}

export interface ImageAttachment {
  data: string // base64
  mediaType: string
  name: string
}

export interface InputBarProps {
  onSend: (text: string, attachments?: FileAttachment[]) => void
  onInterrupt: () => void
  disabled?: boolean
  isBusy?: boolean
  isStreaming?: boolean
  /** Chat redesign #6391: the canonical chat-activity state
   *  (idle/thinking/busy/waiting/error) from store-core's deriveChatActivity.
   *  Surfaced as a `data-activity-state` attribute so the live hairline +
   *  state-lozenge (slices 4-5) are pure CSS keyed off it. */
  chatActivityState?: string
  placeholder?: string
  filePickerFiles?: FilePickerItem[] | null
  onFileTrigger?: () => void
  attachments?: FileAttachment[]
  onRemoveAttachment?: (path: string) => void
  slashCommands?: SlashCommand[]
  onSlashTrigger?: () => void
  onImagePaste?: (files: File[]) => void
  onImageDrop?: (files: File[]) => void
  imageAttachments?: ImageAttachment[]
  onRemoveImage?: (index: number) => void
  onFileAttach?: (path: string) => void
  /** Controlled value for per-session draft persistence */
  controlledValue?: string
  /** Called when text changes (for per-session draft persistence) */
  onValueChange?: (value: string) => void
  /** When true, bare Enter sends; when false (default), Cmd/Ctrl+Enter sends. */
  sendOnEnter?: boolean
  /** Voice input state (from useVoiceInput hook) */
  voiceInput?: {
    isRecording: boolean
    isAvailable: boolean
    transcript: string
    /** #5668 — last recognition/helper error (e.g. mic permission denied,
     * helper spawn failure). Captured by `useVoiceInput` but previously
     * never surfaced, so a failed recording flipped the mic off silently.
     * Cleared on the next `start()`. */
    error: string | null
    start: () => void
    stop: () => void
  }
  /** #3068 — When provided, renders an Evaluate button that runs the draft
   * through the prompt evaluator before sending. The result is shown inline;
   * for rewrite verdicts the user gets an "Apply rewrite" button that swaps
   * the input value. */
  onEvaluate?: (draft: string) => Promise<EvaluatorResultPayload>
  /** #3797 — large-paste collapse. When the user pastes text that meets the
   * shared `shouldCollapsePaste` threshold, the textarea intercepts the
   * paste, calls `onLargePaste(text)` so the parent can stash the content,
   * and splices the returned marker string into the draft at the cursor.
   * If the prop is omitted, paste behaviour is unchanged. */
  onLargePaste?: (text: string) => string
  /** #3797 — chips for collapsed pastes currently in the composer. */
  pastedTextBlocks?: { id: number; content: string }[]
  /** #3797 — click handler for the eye / chip body (open the inspect modal). */
  onInspectPastedText?: (id: number) => void
  /** #3797 — × handler that removes the chip and strips the inline marker. */
  onRemovePastedText?: (id: number) => void
  /**
   * #3698 — terminal-style Up/Down history. **Oldest-first** list of the
   * user's previously sent message texts in the current session (i.e. the
   * natural array order from `messages.filter(m => m.type === 'user_input')`).
   * Up at caret==0 (or at caret==value.length with the caret collapsed)
   * recalls the most recent message; further Ups walk further back; Down
   * walks forward toward the most recent; Down past the newest restores the
   * in-progress draft.
   *
   * The component treats index `length-1` as the newest entry and `0` as the
   * oldest — this matches how App.tsx already orders messages by arrival, so
   * the caller can pass the filtered array verbatim without a reverse() copy.
   *
   * History is per-session: pass a fresh array reference when the active
   * session changes (App.tsx already does this since `messages` comes
   * from `getActiveSessionState()`). The component resets its cycling
   * index whenever this prop's array identity changes — so a fresh
   * session, a newly sent message (history grows), or any other reason
   * the parent rebuilds the array will start the next Up at the newest
   * entry rather than continuing from a stale index.
   *
   * Omit the prop (or pass `undefined`) to disable history navigation
   * entirely — Up/Down then revert to plain cursor movement.
   */
  userMessageHistory?: string[]
  /**
   * #4306 — when true, render the inline "thinking keyword" highlight
   * overlay (matches `ultrathink`, `megathink`, `think harder`, `think hard`,
   * `think` case-insensitively at word boundaries). Caller MUST gate this
   * on whether the active session's provider actually supports the
   * server-side escalation — currently the SDK provider only. Highlighting
   * on a provider that ignores the keyword would imply an escalation the
   * server does not perform; see #4306's "do not lie to the user" gate.
   *
   * When omitted / false, the overlay renders nothing and the textarea
   * behaves exactly as before (plain visible text, no transparency hack).
   */
  highlightThinkingKeywords?: boolean
}

type EvaluatorState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'result', result: EvaluatorResultPayload }
  | { kind: 'error', message: string }

// #5668 — Control-hold push-to-talk. Unlike the old Space gesture, Control is
// not text input, so we never suppress and re-insert characters in the
// controlled textarea. A short threshold gives normal Ctrl shortcuts time to
// cancel the arm before voice starts.
const CONTROL_PTT_HOLD_MS = 250
type ControlPttState = 'idle' | 'arming' | 'recording'

// #6637 — window-scoped push-to-talk must not hijack Control while the user is
// typing in some OTHER text field (a search box, a rename input, etc.). Only the
// composer textarea and non-editable focus targets (body, buttons, the chat
// scroller) arm voice; any other editable element is left to its own Control use.
function isEditableElement(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (el as HTMLElement).isContentEditable === true
}

export function InputBar({ onSend, onInterrupt, disabled, isBusy, isStreaming, chatActivityState, placeholder, filePickerFiles, onFileTrigger, attachments, onRemoveAttachment, slashCommands, onSlashTrigger, onImagePaste, onImageDrop, imageAttachments, onRemoveImage, onFileAttach, controlledValue, onValueChange, sendOnEnter, voiceInput, onEvaluate, onLargePaste, pastedTextBlocks, onInspectPastedText, onRemovePastedText, userMessageHistory, highlightThinkingKeywords }: InputBarProps) {
  const [internalValue, setInternalValue] = useState('')
  const value = controlledValue !== undefined ? controlledValue : internalValue
  const setValue = onValueChange || setInternalValue
  const dictationStartRef = useRef(0)
  // #5610 — text that sat *after* the dictation anchor when capture began.
  // The transcript is spliced between the prefix and this suffix so caret-
  // anchored dictation (voice shortcut mid-draft) doesn't truncate everything
  // past the caret. For the mic button the anchor is the end of the value, so
  // the suffix is empty and behaviour is unchanged.
  const dictationSuffixRef = useRef('')
  const controlPttStateRef = useRef<ControlPttState>('idle')
  const controlPttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceStopRef = useRef<(() => void) | undefined>(undefined)
  voiceStopRef.current = voiceInput?.stop
  // #6752 review — current armability, read at arm-timer fire so a `disabled` /
  // `isAvailable` / `isRecording` change DURING the 250ms arming window can't
  // still tip the mic on. A ref (not effect teardown) so a benign re-render
  // mid-arm never spuriously cancels a legitimate hold.
  const pttArmableRef = useRef(false)
  pttArmableRef.current = Boolean(voiceInput?.isAvailable) && !disabled && !voiceInput?.isRecording
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const shortcutsId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // #4306 — thinking-keyword highlight overlay. Mirror div behind a
  // transparent-text textarea; identical box metrics in CSS (font, padding,
  // line-height, white-space) so the overlay's <span>-wrapped keywords line
  // up pixel-perfect with the user's literal text.
  //
  // We hold an overlayRef and `useLayoutEffect`-sync `scrollTop` from the
  // textarea so multi-line drafts scroll the highlight along with the cursor.
  // (No `useState` for scrollTop — we'd re-render on every keystroke for a
  // value the DOM owns.)
  const overlayRef = useRef<HTMLDivElement>(null)
  const tokens = useMemo(
    () => highlightThinkingKeywords ? tokenizeThinkingKeywords(value) : null,
    [value, highlightThinkingKeywords]
  )

  // #3068 — manual prompt evaluator state machine. Lives in InputBar because
  // applying a rewrite has to swap the textarea value and re-focus it.
  const [evaluatorState, setEvaluatorState] = useState<EvaluatorState>({ kind: 'idle' })

  // #3698 — terminal-style Up/Down history cycling. `historyIndex === null`
  // means we're not currently cycling (so the next Up may stash the in-
  // progress draft and step to the newest entry). A non-null index walks
  // newest → oldest as the user presses Up; Down steps back toward newest,
  // and Down past index 0 exits cycling and restores the stashed draft.
  //
  // Both pieces of state are intentionally ephemeral — they live in the
  // component (not the Zustand store) because they're pure UI state with no
  // persistence requirement. See the prop JSDoc above for the per-session
  // reset behaviour driven by `userMessageHistory` array identity.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [draftBeforeCycle, setDraftBeforeCycle] = useState<string>('')

  // Reset the cycling state whenever the history array reference changes.
  // This covers two natural triggers:
  //   1. The user sends a message → App.tsx pushes a new user_input entry,
  //      which rebuilds the filtered history array → identity changes → reset.
  //   2. The user switches sessions → activeSessionId flips →
  //      getActiveSessionState() returns a different messages array → reset.
  // We intentionally key only on the array reference, not its contents, so we
  // don't pay a deep-compare cost on every render.
  useEffect(() => {
    setHistoryIndex(null)
    setDraftBeforeCycle('')
  }, [userMessageHistory])

  const handleEvaluate = useCallback(async () => {
    if (!onEvaluate) return
    const draft = value.trim()
    if (!draft) return
    setEvaluatorState({ kind: 'pending' })
    try {
      const result = await onEvaluate(draft)
      setEvaluatorState({ kind: 'result', result })
    } catch (err) {
      setEvaluatorState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [onEvaluate, value])

  const dismissEvaluator = useCallback(() => {
    setEvaluatorState({ kind: 'idle' })
  }, [])

  const applyRewrite = useCallback((rewrite: string) => {
    setValue(rewrite)
    setEvaluatorState({ kind: 'idle' })
    textareaRef.current?.focus()
  }, [setValue])

  // Find the last qualifying @ (at start or after whitespace)
  const triggerAtIdx = useMemo(() => {
    for (let i = value.length - 1; i >= 0; i--) {
      if (value[i] === '@' && (i === 0 || /\s/.test(value[i - 1]!))) return i
    }
    return -1
  }, [value])

  // Extract filter text after @ trigger
  const fileFilter = useMemo(() => {
    if (!filePickerOpen) return ''
    if (triggerAtIdx < 0) return ''
    return value.slice(triggerAtIdx + 1)
  }, [filePickerOpen, value, triggerAtIdx])

  // Filtered files for keyboard navigation bounds
  const filteredFiles = useMemo(() => {
    if (filePickerFiles === undefined) return []
    if (filePickerFiles === null) return []
    if (!fileFilter) return filePickerFiles
    const lower = fileFilter.toLowerCase()
    return filePickerFiles.filter(f => f.path.toLowerCase().includes(lower))
  }, [filePickerFiles, fileFilter])

  const selectFile = useCallback((path: string) => {
    if (triggerAtIdx >= 0) {
      const before = value.slice(0, triggerAtIdx)
      const afterAt = value.slice(triggerAtIdx + 1)
      const nextWs = afterAt.search(/\s/)
      const suffix = nextWs === -1 ? '' : afterAt.slice(nextWs)
      setValue(before + path + (suffix || ' '))
    }
    onFileAttach?.(path)
    setFilePickerOpen(false)
    setFileSelectedIndex(0)
  }, [value, triggerAtIdx, onFileAttach])

  // Derive slash filter from current value (text after "/")
  const slashFilter = pickerOpen && value.startsWith('/') ? value.slice(1) : ''

  // Single source of truth for filtered commands — used by both picker and keyboard handler
  const filteredCommands = useMemo(() => {
    if (!slashCommands || slashCommands.length === 0) return []
    if (!slashFilter) return slashCommands
    const lower = slashFilter.toLowerCase()
    return slashCommands.filter(
      c => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower)
    )
  }, [slashCommands, slashFilter])

  const dedupedAttachments = useMemo(() => {
    if (!attachments) return undefined
    const seen = new Set<string>()
    return attachments.filter(att => {
      if (seen.has(att.path)) return false
      seen.add(att.path)
      return true
    })
  }, [attachments])

  // #3903 — `canSubmit` mirrors every input mode that send() (or the parent's
  // handleSend) would actually dispatch: text, file attachments, image
  // attachments, or collapsed-paste blocks. Used both as the busy-state Send-
  // visibility gate (replaces the old `value.trim()`-only check, which hid
  // Send for attachment-only follow-ups while a turn was in flight) and as
  // a defensive guard inside send() itself. Images and pasted-text live in
  // App-state, not in InputBar's send() body, but they ride along on the
  // wire (App.tsx:1008) — so the button must light up for them too.
  //
  // #3984 — pasted blocks are *only* dispatched when their `[Pasted text #N]`
  // marker appears in `value` (App.tsx calls expandPasteMarkers(text, blocks),
  // which is a regex sweep over `text`). If the user deletes the marker but
  // the chip persists, treating `pastedTextBlocks.length > 0` as dispatchable
  // makes Send fire `onSend('')` and silently drop the paste. Gate paste
  // contribution to canSubmit on whether at least one block id is actually
  // referenced by an in-text marker.
  const hasReferencedPaste = useMemo(() => {
    if (!pastedTextBlocks || pastedTextBlocks.length === 0) return false
    const active = findActiveMarkerIds(value)
    if (active.size === 0) return false
    for (const blk of pastedTextBlocks) {
      if (active.has(blk.id)) return true
    }
    return false
  }, [value, pastedTextBlocks])
  const canSubmit = useMemo(() => {
    const hasText = value.trim().length > 0
    const hasAtts = (dedupedAttachments?.length ?? 0) > 0
    const hasImgs = (imageAttachments?.length ?? 0) > 0
    return hasText || hasAtts || hasImgs || hasReferencedPaste
  }, [value, dedupedAttachments, imageAttachments, hasReferencedPaste])

  const send = useCallback(() => {
    const trimmed = value.trim()
    const hasAtts = dedupedAttachments && dedupedAttachments.length > 0
    if (!canSubmit) return
    if (hasAtts) {
      onSend(trimmed, dedupedAttachments)
    } else {
      onSend(trimmed)
    }
    setValue('')
    setFilePickerOpen(false)
    setFileSelectedIndex(0)
    setPickerOpen(false)
    setSelectedIndex(0)
    // #3068: drop any visible evaluator panel — its draft has been sent so the
    // result no longer applies to the current input value.
    setEvaluatorState({ kind: 'idle' })
    // #3698: sending exits cycling mode. The userMessageHistory effect already
    // resets when the parent rebuilds the array, but doing it here too makes
    // the local state consistent immediately (before the parent re-render
    // pushes the new history through).
    setHistoryIndex(null)
    setDraftBeforeCycle('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, onSend, dedupedAttachments, canSubmit])

  const selectCommand = useCallback((name: string) => {
    setValue(`/${name} `)
    setPickerOpen(false)
    setSelectedIndex(0)
    textareaRef.current?.focus()
  }, [])

  const closePicker = useCallback(() => {
    setPickerOpen(false)
    setSelectedIndex(0)
  }, [])

  // #3853: Cmd+L / Ctrl+L — clear the composer (text + all queued attachments,
  // images, and pasted-text blocks). Returns true if something was cleared so
  // the keydown handler only preventDefault()s when the shortcut actually did
  // something (lets the browser's native Ctrl+L fall through for an empty
  // composer in environments like Chrome/Edge where the user might want the
  // address-bar focus).
  const clearComposer = useCallback((): boolean => {
    const hasText = (value ?? '').length > 0
    const hasAtts = (attachments?.length ?? 0) > 0
    const hasImgs = (imageAttachments?.length ?? 0) > 0
    const hasPastes = (pastedTextBlocks?.length ?? 0) > 0
    if (!hasText && !hasAtts && !hasImgs && !hasPastes) return false

    setValue('')
    if (attachments && onRemoveAttachment) {
      for (const att of attachments) onRemoveAttachment(att.path)
    }
    if (imageAttachments && onRemoveImage) {
      // Iterate from end so callers that splice on each call don't re-index
      // pending items.
      for (let i = imageAttachments.length - 1; i >= 0; i--) onRemoveImage(i)
    }
    if (pastedTextBlocks && onRemovePastedText) {
      for (const blk of pastedTextBlocks) onRemovePastedText(blk.id)
    }
    // #3853 review: reset the explicit height set by handleChange's auto-
    // resize logic. setValue('') alone doesn't re-run the resize path, so
    // a cleared multi-line draft would leave the textarea visually tall.
    // Mirrors the height reset send() does after a successful send.
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    textareaRef.current?.focus()
    return true
  }, [value, attachments, imageAttachments, pastedTextBlocks, onRemoveAttachment, onRemoveImage, onRemovePastedText, setValue])

  // #3698 — recall a history entry by depth (0 = newest, 1 = one back, …).
  // Walks the textarea value through the parent's setValue (so controlled
  // mode stays in sync) and parks the caret at the end on the next animation
  // frame so the user can immediately edit at the tail of the recalled text —
  // matches shell `up-arrow` UX. The array is oldest-first, so depth maps to
  // `length - 1 - depth`.
  const recallHistoryAtDepth = useCallback((depth: number) => {
    const entries = userMessageHistory
    if (!entries || entries.length === 0) return
    const arrayIdx = entries.length - 1 - depth
    if (arrayIdx < 0 || arrayIdx >= entries.length) return
    const entry = entries[arrayIdx]
    if (entry === undefined) return
    setValue(entry)
    setHistoryIndex(depth)
    // Park the caret at the end on the next frame, after React applies the
    // controlled-value update. Without rAF the setSelectionRange runs before
    // the new value is reflected in textarea.value, so the caret ends up at
    // the wrong spot.
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (!t) return
      const end = t.value.length
      t.setSelectionRange(end, end)
    })
  }, [userMessageHistory, setValue])

  // Voice keyboard shortcut. Space used to be a hold-to-talk trigger, but that
  // required suppressing and re-inserting native spaces in a controlled
  // textarea. Under fast typing this could reorder text or move the caret, so
  // voice now uses an explicit modifier chord and leaves Space entirely native.
  //
  // Known collision: Cmd/Ctrl+Shift+M is bound by some browsers/tools (e.g.
  // Firefox's Responsive Design Mode, VS Code). preventDefault() on a textarea
  // keydown cannot reliably beat a browser-chrome accelerator, so in those
  // environments the chord may both toggle voice AND trigger the browser tool.
  // Documented rather than remapped to keep the affordance familiar; revisit if
  // it proves annoying in practice.
  const isVoiceShortcut = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    return (
      (e.key === 'm' || e.key === 'M') &&
      e.shiftKey &&
      !e.altKey &&
      (e.metaKey || e.ctrlKey)
    )
  }, [])

  const startVoiceAtCaret = useCallback(() => {
    if (!voiceInput) return
    const el = textareaRef.current
    const anchor = el?.selectionStart ?? value.length
    dictationStartRef.current = anchor
    dictationSuffixRef.current = value.slice(el?.selectionEnd ?? anchor)
    voiceInput.start()
  }, [voiceInput, value])

  const clearControlPttTimer = useCallback(() => {
    if (controlPttTimerRef.current !== null) {
      clearTimeout(controlPttTimerRef.current)
      controlPttTimerRef.current = null
    }
  }, [])

  const cancelControlPttArm = useCallback(() => {
    if (controlPttStateRef.current === 'arming') {
      clearControlPttTimer()
      controlPttStateRef.current = 'idle'
    }
  }, [clearControlPttTimer])

  const stopControlPttRecording = useCallback(() => {
    if (controlPttStateRef.current === 'recording') {
      controlPttStateRef.current = 'idle'
      voiceStopRef.current?.()
    }
  }, [])

  // Shared arming primitive for both the composer-scoped handler and the
  // window-scoped one (#6637). `focusComposerFirst` moves focus into the
  // composer before recording tips in, so a window-scoped hold (fired while
  // focus was elsewhere) still lands its transcript in the composer at the
  // caret/end anchor.
  const armControlPtt = useCallback((focusComposerFirst: boolean) => {
    if (controlPttStateRef.current !== 'idle') return
    controlPttStateRef.current = 'arming'
    clearControlPttTimer()
    controlPttTimerRef.current = setTimeout(() => {
      controlPttTimerRef.current = null
      if (controlPttStateRef.current !== 'arming') return
      // #6752 review: voice may have been disabled / made unavailable / already
      // started during the hold — never open the mic in that case.
      if (!pttArmableRef.current) {
        controlPttStateRef.current = 'idle'
        return
      }
      controlPttStateRef.current = 'recording'
      if (focusComposerFirst) textareaRef.current?.focus()
      startVoiceAtCaret()
    }, CONTROL_PTT_HOLD_MS)
  }, [clearControlPttTimer, startVoiceAtCaret])

  const handleControlPttKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Control') return false
    if (!voiceInput?.isAvailable || disabled || voiceInput.isRecording) return false
    if (e.metaKey || e.altKey || e.shiftKey) return false
    if (controlPttStateRef.current !== 'idle') return true

    armControlPtt(false)
    return true
  }, [voiceInput, disabled, armControlPtt])

  const handleControlPttKeyUp = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Control') return
    if (controlPttStateRef.current === 'arming') {
      clearControlPttTimer()
      controlPttStateRef.current = 'idle'
    } else {
      stopControlPttRecording()
    }
  }, [clearControlPttTimer, stopControlPttRecording])

  const handleControlPttBlur = useCallback(() => {
    cancelControlPttArm()
    stopControlPttRecording()
  }, [cancelControlPttArm, stopControlPttRecording])

  // A pointer press while Control is held means Control was a click-modifier
  // (e.g. macOS Ctrl+click / right-click), NOT a push-to-talk hold. Mouse events
  // fire no keydown, so without this an armed Control-hold would still tip into
  // recording ~250ms later and open the mic. Cancelling the arm (and stopping an
  // already-live Control-hold capture) on pointer-down closes that gesture hole.
  // A mic-button recording is unaffected — it never enters the 'recording' state
  // this guards on.
  const handleControlPttPointerDown = useCallback(() => {
    cancelControlPttArm()
    stopControlPttRecording()
  }, [cancelControlPttArm, stopControlPttRecording])

  // #6637 — window-scoped push-to-talk. The composer-scoped textarea handlers
  // above only fire when the composer is focused; this document-level listener
  // extends the Control-hold gesture to anywhere in the Chroxy window. It stays
  // out of the way when focus is in the composer (its own handler owns that) or
  // in some OTHER editable element (never hijack another field's Control), and
  // on fire it focuses the composer so the transcript lands there. Voice
  // availability + the shared `controlPttStateRef` mean the two handlers can't
  // double-arm, and keyup/pointerdown teardown is idempotent across both.
  useEffect(() => {
    if (!voiceInput?.isAvailable || disabled) return

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      // Any non-Control key during an arm/recording is a chord (Ctrl+Shift+…) or
      // a shortcut, not a push-to-talk hold — cancel the arm and stop a live
      // capture, mirroring the composer-scoped handler. Without this, pressing
      // Ctrl then Shift would still tip into recording ~250ms later (#6752
      // review). The cancel/stop helpers are internally guarded, so this is a
      // no-op unless we're actually arming/recording.
      if (e.key !== 'Control') {
        cancelControlPttArm()
        stopControlPttRecording()
        return
      }
      if (e.metaKey || e.altKey || e.shiftKey) return
      if (voiceInput.isRecording) return
      if (controlPttStateRef.current !== 'idle') return
      const active = document.activeElement
      if (active === textareaRef.current) return   // composer handler owns it
      if (isEditableElement(active)) return          // don't hijack another field
      armControlPtt(true)
    }
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Control') return
      if (controlPttStateRef.current === 'arming') {
        clearControlPttTimer()
        controlPttStateRef.current = 'idle'
      } else {
        stopControlPttRecording()
      }
    }
    const onPointerDown = () => {
      cancelControlPttArm()
      stopControlPttRecording()
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [voiceInput?.isAvailable, voiceInput?.isRecording, disabled, armControlPtt, clearControlPttTimer, stopControlPttRecording, cancelControlPttArm])

  useEffect(() => {
    return () => {
      clearControlPttTimer()
      stopControlPttRecording()
      controlPttStateRef.current = 'idle'
    }
  }, [clearControlPttTimer, stopControlPttRecording])

  const toggleVoiceFromKeyboard = useCallback(() => {
    if (!voiceInput) return
    if (voiceInput.isRecording) {
      voiceInput.stop()
    } else {
      startVoiceAtCaret()
    }
  }, [voiceInput, startVoiceAtCaret])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Control') {
      if (handleControlPttKeyDown(e)) return
    } else {
      cancelControlPttArm()
      stopControlPttRecording()
    }

    if (voiceInput?.isAvailable && !disabled && isVoiceShortcut(e)) {
      e.preventDefault()
      toggleVoiceFromKeyboard()
      return
    }

    // Slash command picker keyboard handling
    if (pickerOpen) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePicker()
        return
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        if (filteredCommands.length > 0) {
          e.preventDefault()
          const idx = Math.min(selectedIndex, filteredCommands.length - 1)
          selectCommand(filteredCommands[idx]!.name)
          return
        }
        // #4342 — empty filtered list ("No commands found"). Close the picker
        // and fall through to the normal Enter handling below (sendOnEnter,
        // modifier checks, newline). Pre-fix this branch always
        // preventDefault'd + return'd, trapping the user with no way to send.
        closePicker()
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, filteredCommands.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => Math.max(0, i - 1))
        return
      }
    }

    // File picker keyboard handling
    if (filePickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFileSelectedIndex(i => filteredFiles.length === 0 ? 0 : Math.min(i + 1, filteredFiles.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFileSelectedIndex(i => Math.max(0, i - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (filteredFiles.length > 0) {
          selectFile(filteredFiles[fileSelectedIndex]!.path)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setFilePickerOpen(false)
        setFileSelectedIndex(0)
        return
      }
    }

    // #3698 — terminal-style Up/Down history. Only fires when:
    //   - both pickers are closed (handled above, which return early),
    //   - history exists,
    //   - selection is collapsed (no text selected — preserves shift-select),
    //   - and the caret is at a textarea boundary (start for Up, end for Down,
    //     mirroring the "first line / last line" heuristic).
    // We use absolute caret positions (`selectionStart === 0` for Up,
    // `selectionStart === value.length` for Down) so a multi-line draft only
    // recalls history when the user is *already* at the very top or bottom —
    // line-up / line-down movement inside the textarea still works normally.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && userMessageHistory && userMessageHistory.length > 0) {
      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const collapsed = start === end
      const atStart = start === 0
      const atEnd = start === value.length
      if (collapsed) {
        if (e.key === 'ArrowUp' && (atStart || atEnd)) {
          // `historyIndex` is a depth: 0 = newest, length-1 = oldest. Up walks
          // deeper into history; we silently swallow Up at the oldest entry
          // rather than wrapping (matches bash/zsh).
          if (historyIndex === null) {
            e.preventDefault()
            setDraftBeforeCycle(value)
            recallHistoryAtDepth(0)
            return
          }
          if (historyIndex < userMessageHistory.length - 1) {
            e.preventDefault()
            recallHistoryAtDepth(historyIndex + 1)
            return
          }
          // At the oldest entry — preventDefault so the caret doesn't jump out
          // of the textarea, but don't update value.
          e.preventDefault()
          return
        }
        if (e.key === 'ArrowDown' && atEnd && historyIndex !== null) {
          e.preventDefault()
          if (historyIndex > 0) {
            recallHistoryAtDepth(historyIndex - 1)
          } else {
            // Down past the newest entry → exit cycling, restore draft.
            setValue(draftBeforeCycle)
            setHistoryIndex(null)
            // Mirror recallHistoryAtDepth's caret-at-end policy so the user
            // can immediately edit the restored draft without re-positioning.
            requestAnimationFrame(() => {
              const t = textareaRef.current
              if (!t) return
              const endPos = t.value.length
              t.setSelectionRange(endPos, endPos)
            })
          }
          return
        }
      }
    }

    if (e.key === 'Enter') {
      if (sendOnEnter && !e.shiftKey) {
        e.preventDefault()
        send()
      } else if (!sendOnEnter && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        send()
      }
    } else if (e.key === 'Escape') {
      // #3698 — while cycling history, Escape exits cycling and restores the
      // stashed draft instead of firing the interrupt. Once cycling is reset,
      // Escape resumes its original behaviour (`onInterrupt`).
      if (historyIndex !== null) {
        e.preventDefault()
        setValue(draftBeforeCycle)
        setHistoryIndex(null)
        requestAnimationFrame(() => {
          const t = textareaRef.current
          if (!t) return
          const endPos = t.value.length
          t.setSelectionRange(endPos, endPos)
        })
        return
      }
      e.preventDefault()
      onInterrupt()
    } else if ((e.key === 'l' || e.key === 'L') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      // #3853: Cmd+L (mac) / Ctrl+L (linux/win) clears the composer. Only
      // preventDefault on a non-empty composer so the browser's native
      // Ctrl+L (address-bar focus on Chrome/Edge) still works when there's
      // nothing to clear.
      if (clearComposer()) {
        e.preventDefault()
      }
    }
  }, [handleControlPttKeyDown, cancelControlPttArm, stopControlPttRecording, voiceInput?.isAvailable, disabled, isVoiceShortcut, toggleVoiceFromKeyboard, pickerOpen, filePickerOpen, filteredFiles, fileSelectedIndex, selectFile, send, onInterrupt, closePicker, selectCommand, filteredCommands, selectedIndex, sendOnEnter, clearComposer, userMessageHistory, value, historyIndex, draftBeforeCycle, recallHistoryAtDepth, setValue])

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setValue(newValue)

    // #3698 — any direct user edit exits cycling. We only reset when the new
    // value isn't the one we just recalled (recallHistoryAtDepth's setValue()
    // flows through the parent and re-renders, but onChange itself doesn't
    // fire for controlled updates). The cheap guard is "did `historyIndex`
    // get set?" — programmatic recall sets it; real user typing leaves it
    // untouched before this handler runs. The recalled-text equality check
    // covers the edge case where the user retypes the recalled string
    // verbatim (rare).
    if (historyIndex !== null && userMessageHistory) {
      const recalled = userMessageHistory[userMessageHistory.length - 1 - historyIndex]
      if (newValue !== recalled) {
        setHistoryIndex(null)
        setDraftBeforeCycle('')
      }
    }

    // Slash command detection: "/" at start of input
    if (slashCommands && newValue.startsWith('/')) {
      if (!pickerOpen) {
        setPickerOpen(true)
        setSelectedIndex(0)
        onSlashTrigger?.()
      }
    } else {
      if (pickerOpen) {
        closePicker()
      }
    }

    // Detect @ trigger: find last @ that's at start or after whitespace
    if (filePickerFiles !== undefined && newValue.includes('@')) {
      let foundAt = false
      for (let i = newValue.length - 1; i >= 0; i--) {
        if (newValue[i] === '@' && (i === 0 || /\s/.test(newValue[i - 1]!))) {
          foundAt = true
          break
        }
      }
      if (foundAt && !filePickerOpen) {
        setFilePickerOpen(true)
        setFileSelectedIndex(0)
        onFileTrigger?.()
      }
    }

    // Close file picker if @ is removed
    if (filePickerOpen && !newValue.includes('@')) {
      setFilePickerOpen(false)
      setFileSelectedIndex(0)
    }

    // Auto-expand up to 5 lines, derived from computed styles (#1172, #1246)
    const el = e.target
    el.style.height = 'auto'
    const computed = getComputedStyle(el)
    const lineHeight = parseFloat(computed.lineHeight) || 20
    const paddingY = (parseFloat(computed.paddingTop) || 0) + (parseFloat(computed.paddingBottom) || 0)
    const borderY = (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0)
    const maxLines = 5
    // Normalize to outer height (content + padding + border)
    const outerMax = lineHeight * maxLines + paddingY + borderY
    const outerScrollHeight = el.scrollHeight + borderY
    const outerHeight = Math.min(outerScrollHeight, outerMax)
    // Adjust for box-sizing: border-box includes padding+border in height,
    // content-box sets content height only (#1246)
    const assignedHeight = computed.boxSizing === 'border-box'
      ? outerHeight
      : outerHeight - paddingY - borderY
    el.style.height = assignedHeight + 'px'
  }, [slashCommands, pickerOpen, closePicker, onSlashTrigger, filePickerFiles, filePickerOpen, onFileTrigger, historyIndex, userMessageHistory, setValue])

  // Merge voice transcript into input value via effect (not during render)
  const prevTranscriptRef = useRef('')
  useEffect(() => {
    if (voiceInput?.isRecording && voiceInput.transcript && voiceInput.transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = voiceInput.transcript
      const prefix = value.slice(0, dictationStartRef.current)
      const separator = prefix.length > 0 && !prefix.endsWith(' ') ? ' ' : ''
      // #5610 — preserve any text that followed the anchor so caret-anchored
      // dictation splices in place instead of truncating the rest of the draft.
      const suffix = dictationSuffixRef.current
      const trailing = suffix.length > 0 && !suffix.startsWith(' ') ? ' ' : ''
      setValue(prefix + separator + voiceInput.transcript + trailing + suffix)
    }
    if (!voiceInput?.isRecording && prevTranscriptRef.current) {
      prevTranscriptRef.current = ''
    }
  }, [voiceInput?.isRecording, voiceInput?.transcript, value])

  const handleMicPress = useCallback(() => {
    if (!voiceInput) return
    if (voiceInput.isRecording) {
      voiceInput.stop()
    } else {
      dictationStartRef.current = value.length
      dictationSuffixRef.current = ''
      voiceInput.start()
    }
  }, [voiceInput, value.length])

  const hasChips = dedupedAttachments && dedupedAttachments.length > 0

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return
    // Image paste takes priority — only fall through to text handling when
    // the clipboard has no image payload.
    const files = e.clipboardData?.files
    if (onImagePaste && files && files.length > 0) {
      const imageFiles = filterImageFiles(files)
      if (imageFiles.length > 0) {
        e.preventDefault()
        onImagePaste(imageFiles)
        return
      }
    }
    // #3797 — large text paste → collapse to inline marker.
    if (onLargePaste) {
      let text = e.clipboardData?.getData('text/plain') ?? ''
      // Fallback for sources that put HTML on the clipboard with an empty
      // text/plain payload — common when copying rendered markdown out of
      // Tauri's WKWebView (the visible chat view in chroxy itself) or out
      // of other WebKit/Mac apps. Strip tags and reuse the same threshold.
      // #3844 — also fall through when text/plain is present but
      // whitespace-only (some Electron apps / browser extensions emit
      // `"   "` or `"\n\n"` alongside meaningful HTML).
      if (!text.trim()) {
        const html = e.clipboardData?.getData('text/html') ?? ''
        if (html) text = htmlToPlainText(html)
      }
      if (text && shouldCollapsePaste(text)) {
        e.preventDefault()
        const marker = onLargePaste(text)
        const el = textareaRef.current
        const start = el?.selectionStart ?? value.length
        const end = el?.selectionEnd ?? value.length
        const next = value.slice(0, start) + marker + value.slice(end)
        setValue(next)
        // Position the cursor immediately after the inserted marker on the
        // next tick so React has re-rendered with the new value.
        requestAnimationFrame(() => {
          const t = textareaRef.current
          if (!t) return
          const caret = start + marker.length
          t.setSelectionRange(caret, caret)
          t.focus()
        })
      }
    }
  }, [disabled, onImagePaste, onLargePaste, value, setValue])

  const [dragging, setDragging] = useState(false)

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = disabled || !onImageDrop ? 'none' : 'copy'
    }
  }, [disabled, onImageDrop])

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!onImageDrop) return
    e.preventDefault()
    setDragging(true)
  }, [onImageDrop])

  const handleDragLeave = useCallback((_e: DragEvent<HTMLDivElement>) => {
    if (!onImageDrop) return
    setDragging(false)
  }, [onImageDrop])

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    if (disabled || !onImageDrop) return
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    const imageFiles = filterImageFiles(files)
    if (imageFiles.length > 0) {
      onImageDrop(imageFiles)
    }
  }, [disabled, onImageDrop])

  // #4403 — keep the overlay scroll-sync handler referentially stable so
  // every keystroke (while the highlight overlay is on) doesn't allocate a
  // fresh function. Only `overlayRef` is read, which is a ref, so this has
  // no closure deps.
  const handleOverlayScrollSync = useCallback((e: UIEvent<HTMLTextAreaElement>) => {
    const ov = overlayRef.current
    if (ov) ov.scrollTop = e.currentTarget.scrollTop
  }, [])

  const hasImages = imageAttachments && imageAttachments.length > 0

  return (
    <div
      className={`input-bar${dragging ? ' dragging' : ''}`}
      data-testid="input-bar"
      data-activity-state={chatActivityState}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {filePickerOpen && filePickerFiles !== undefined && (
        <FilePicker
          files={filePickerFiles}
          filter={fileFilter}
          onSelect={selectFile}
          onClose={() => { setFilePickerOpen(false); setFileSelectedIndex(0) }}
          selectedIndex={fileSelectedIndex}
        />
      )}
      {hasChips && (
        <div className="attachment-chips" data-testid="attachment-chips">
          {dedupedAttachments.map(att => (
            <AttachmentChip
              key={att.path}
              name={att.name}
              path={att.path}
              onRemove={() => onRemoveAttachment?.(att.path)}
            />
          ))}
        </div>
      )}
      {hasImages && (
        <div className="image-thumbnails" data-testid="image-thumbnails">
          {imageAttachments.map((img, i) => (
            <ImageThumbnail
              key={`${img.name}-${i}`}
              data={img.data}
              mediaType={img.mediaType}
              name={img.name}
              onRemove={() => onRemoveImage?.(i)}
            />
          ))}
          {imageAttachments.length > 1 && (
            <span className="image-count">{imageAttachments.length} images</span>
          )}
        </div>
      )}
      {pastedTextBlocks && pastedTextBlocks.length > 0 && (
        <div className="attachment-chips pasted-text-chips" data-testid="pasted-text-chips">
          {pastedTextBlocks.map(block => {
            let lineCount = 1
            for (let i = 0; i < block.content.length; i++) {
              if (block.content.charCodeAt(i) === 10) lineCount++
            }
            return (
              <PastedTextChip
                key={block.id}
                id={block.id}
                lineCount={lineCount}
                charCount={block.content.length}
                onInspect={onInspectPastedText ?? (() => {})}
                onRemove={onRemovePastedText ?? (() => {})}
              />
            )
          })}
        </div>
      )}
      <span id={shortcutsId} className="sr-only">
        {sendOnEnter ? 'Press Enter to send, Shift+Enter for newline, Escape to interrupt' : 'Press Cmd/Ctrl+Enter to send, Escape to interrupt'}
        {voiceInput?.isAvailable ? ', hold Control for voice input, Cmd/Ctrl+Shift+M to toggle voice input' : ''}
      </span>
      {pickerOpen && slashCommands && (
        <SlashCommandPicker
          commands={slashCommands}
          filter={slashFilter}
          onSelect={selectCommand}
          onClose={closePicker}
          selectedIndex={selectedIndex}
        />
      )}
      {isBusy && !isStreaming && (
        <div className="thinking-indicator" data-testid="thinking-indicator">
          <span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" />
          <span className="thinking-text">Thinking...</span>
        </div>
      )}
      {evaluatorState.kind !== 'idle' && (
        <EvaluatorPanel
          state={evaluatorState}
          onApplyRewrite={applyRewrite}
          onDismiss={dismissEvaluator}
        />
      )}
      {/* #5668 — surface voice recognition/helper failures instead of
          flipping the mic off silently. `voiceInput.error` is cleared on the
          next start(), so retrying dismisses it. role="alert" announces it to
          screen readers (the failure is otherwise invisible). */}
      {voiceInput?.error && (
        <div className="voice-error" data-testid="voice-error" role="alert">
          <span className="voice-error-icon" aria-hidden="true">⚠</span>
          <span className="voice-error-text">{voiceInput.error}</span>
        </div>
      )}
      <div className={`input-bar-textarea-wrap${tokens ? ' has-overlay' : ''}`}>
        {tokens && (
          // Mirror div behind the textarea (#4306). Identical box metrics
          // (font, padding, line-height, white-space) are enforced in CSS
          // via the .input-bar-textarea-wrap.has-overlay selector pair so
          // the overlay characters land in the same x/y as the textarea's
          // own characters. aria-hidden because the textarea is the
          // authoritative input — the overlay is purely visual.
          <div
            ref={overlayRef}
            className="input-bar-textarea-overlay"
            aria-hidden="true"
            data-testid="thinking-keyword-overlay"
          >
            {tokens.map((tok, i) => (
              tok.kind === 'keyword'
                ? <span key={i} className="thinking-keyword" data-testid="thinking-keyword">{tok.text}</span>
                : <span key={i}>{tok.text}</span>
            ))}
            {/* Trailing whitespace handling: a trailing newline at the end
                of the textarea content doesn't create a new line in a
                contenteditable-style div without an explicit terminator.
                Append a zero-width space inside a span so the overlay's
                height matches the textarea's when the user ends with `\n`. */}
            {value.endsWith('\n') && <span>{'​'}</span>}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleControlPttKeyUp}
          onBlur={handleControlPttBlur}
          onMouseDown={handleControlPttPointerDown}
          onPaste={handlePaste}
          // Scroll-sync the overlay to the textarea so multi-line drafts
          // keep keyword highlights aligned as the user scrolls within the
          // textarea. Direct DOM write (not state) — same reason as the
          // auto-resize logic in handleChange. Handler is memoised (#4403)
          // so it doesn't churn a fresh function per keystroke.
          onScroll={tokens ? handleOverlayScrollSync : undefined}
          disabled={disabled}
          placeholder={isBusy ? 'Type to send follow-up...' : placeholder}
          aria-label="Message input"
          aria-describedby={shortcutsId}
          rows={1}
        />
      </div>
      <div className="input-bar-actions">
        {/* Chat redesign #6391 (slice 5): always-visible Enter-mode keyhint so
            the send key is never a guess. aria-hidden — the sr-only
            #shortcutsId span above carries the full hint for screen readers. */}
        <span className="input-bar-keyhint" aria-hidden="true" data-testid="input-bar-keyhint">
          {sendOnEnter ? '⏎ send · ⇧⏎ newline' : '⌘⏎ send'}
        </span>
        {voiceInput?.isAvailable && (
          <button
            data-testid="mic-button"
            className={`btn-mic${voiceInput.isRecording ? ' recording' : ''}`}
            onClick={handleMicPress}
            disabled={disabled}
            type="button"
            aria-label={voiceInput.isRecording ? 'Stop recording' : 'Start voice input'}
            aria-keyshortcuts="Control Meta+Shift+M Control+Shift+M"
            title={voiceInput.isRecording ? 'Stop recording' : 'Hold Control to dictate, or Cmd/Ctrl+Shift+M to toggle'}
          >
            {voiceInput.isRecording ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            )}
          </button>
        )}
        {onEvaluate && !((isStreaming || isBusy) && !value.trim()) && (
          <button
            data-testid="evaluate-button"
            className="btn-evaluate"
            onClick={handleEvaluate}
            disabled={disabled || !value.trim() || evaluatorState.kind === 'pending'}
            type="button"
            aria-label="Evaluate this draft before sending"
            title="Evaluate this draft message — Claude opus will check it for clarity before you send."
          >
            {evaluatorState.kind === 'pending' ? 'Evaluating…' : 'Evaluate'}
          </button>
        )}
        {/* #3850: while a turn is in flight, Stop must stay reachable even
            when the user has typed a follow-up. Pre-fix, the toggle was
            gated on `!value.trim()` — typing anything hid Stop and forced
            users to either clear the input or hit Escape (undiscoverable).
            Now both buttons appear side-by-side when busy + draft, mirroring
            Claude.ai / ChatGPT's queued-follow-up UX. Stop keeps the
            rightmost position so its location is stable across all
            busy states. */}
        {(isStreaming || isBusy) ? (
          <>
            {/* #3903 — gate on `canSubmit` (mirrors send()) so the Send
                button surfaces for attachment-only follow-ups (file picks,
                images, collapsed pastes) — not just typed text. Pre-fix,
                dragging a file in while a turn was in flight showed only
                Stop; the queue affordance was unreachable until the user
                typed a character or waited for the turn to end. */}
            {canSubmit && (
              <button
                data-testid="send-button"
                className="btn-send"
                onClick={send}
                disabled={disabled}
                type="button"
                aria-label="Send follow-up"
              >
                Send
              </button>
            )}
            <button
              data-testid="interrupt-button"
              className="btn-interrupt"
              onClick={onInterrupt}
              type="button"
              aria-label="Stop generation"
            >
              Stop
            </button>
          </>
        ) : (
          <button
            data-testid="send-button"
            className="btn-send"
            onClick={send}
            disabled={disabled}
            type="button"
            aria-label="Send message"
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}

// #3100: map upstream HTTP status to an actionable recovery hint. Returns
// null when there's no specific guidance to add — the generic error message
// is enough on its own.
function evaluatorRecoveryHint(status: number | undefined): string | null {
  if (status === 401 || status === 403) {
    return 'Check your ANTHROPIC_API_KEY.'
  }
  if (status === 429) {
    return 'Try again in a moment.'
  }
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return 'Anthropic upstream is unavailable — try again shortly.'
  }
  return null
}

/**
 * Inline evaluator result panel (#3068). Renders one of:
 *   - pending spinner
 *   - error banner
 *   - verdict-specific result UI (forward / rewrite / clarify)
 */
function EvaluatorPanel({
  state,
  onApplyRewrite,
  onDismiss,
}: {
  state: Exclude<EvaluatorState, { kind: 'idle' }>
  onApplyRewrite: (rewrite: string) => void
  onDismiss: () => void
}) {
  if (state.kind === 'pending') {
    return (
      <div
        className="evaluator-panel evaluator-panel--pending"
        data-testid="evaluator-panel"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="evaluator-spinner" aria-hidden="true" />
        <span className="evaluator-text">Evaluating draft…</span>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="evaluator-panel evaluator-panel--error" data-testid="evaluator-panel" role="alert">
        <span className="evaluator-label">Evaluator error:</span>
        <span className="evaluator-text">{state.message}</span>
        <button type="button" className="evaluator-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
      </div>
    )
  }

  // state.kind === 'result'
  const { result } = state

  if (result.error) {
    return (
      <div className="evaluator-panel evaluator-panel--error" data-testid="evaluator-panel" role="alert">
        <span className="evaluator-label">Evaluator error ({result.error.code}):</span>
        <span className="evaluator-text">{result.error.message}</span>
        {(() => {
          // #3100: surface a specific recovery hint when the upstream API
          // returned a known status. The server passes the numeric status
          // through `error.status` so we can branch without parsing the
          // sanitized `message` string.
          const hint = evaluatorRecoveryHint(result.error.status)
          if (!hint) return null
          return (
            <span className="evaluator-hint" data-testid="evaluator-hint">{hint}</span>
          )
        })()}
        <button type="button" className="evaluator-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
      </div>
    )
  }

  const verdict = result.verdict
  const reasoning = result.reasoning || ''

  if (verdict === 'forward') {
    return (
      <div
        className="evaluator-panel evaluator-panel--forward"
        data-testid="evaluator-panel"
        data-verdict="forward"
        role="status"
        aria-live="polite"
      >
        <span className="evaluator-label">Looks clear.</span>
        {reasoning && <span className="evaluator-text">{reasoning}</span>}
        <button type="button" className="evaluator-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
      </div>
    )
  }

  if (verdict === 'rewrite' && result.rewritten) {
    return (
      <div
        className="evaluator-panel evaluator-panel--rewrite"
        data-testid="evaluator-panel"
        data-verdict="rewrite"
        role="status"
        aria-live="polite"
      >
        <div className="evaluator-row">
          <span className="evaluator-label">Suggested rewrite</span>
          {reasoning && <span className="evaluator-text">— {reasoning}</span>}
        </div>
        <pre className="evaluator-rewrite-text">{result.rewritten}</pre>
        <div className="evaluator-actions">
          <button
            type="button"
            className="btn-evaluator-apply"
            data-testid="evaluator-apply"
            onClick={() => onApplyRewrite(result.rewritten!)}
          >
            Apply rewrite
          </button>
          <button type="button" className="btn-evaluator-dismiss" onClick={onDismiss}>
            Keep original
          </button>
        </div>
      </div>
    )
  }

  if (verdict === 'clarify' && result.clarification) {
    return (
      <div
        className="evaluator-panel evaluator-panel--clarify"
        data-testid="evaluator-panel"
        data-verdict="clarify"
        role="status"
        aria-live="polite"
      >
        <div className="evaluator-row">
          <span className="evaluator-label">Clarification needed</span>
          {reasoning && <span className="evaluator-text">— {reasoning}</span>}
        </div>
        <p className="evaluator-clarification">{result.clarification}</p>
        <div className="evaluator-actions">
          <button type="button" className="btn-evaluator-dismiss" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </div>
    )
  }

  // Unknown shape — fail safe by surfacing the raw reasoning.
  return (
    <div
      className="evaluator-panel evaluator-panel--forward"
      data-testid="evaluator-panel"
      role="status"
      aria-live="polite"
    >
      <span className="evaluator-text">{reasoning || 'Evaluator returned an unexpected response.'}</span>
      <button type="button" className="evaluator-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  )
}
