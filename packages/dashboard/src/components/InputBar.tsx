/**
 * InputBar — auto-expanding textarea with send/interrupt and slash command picker.
 *
 * Enter for newline, Cmd/Ctrl+Enter to send, Escape to interrupt.
 * Supports file picker (@ trigger), attachment chips, slash command picker (/ trigger),
 * image paste/drag-drop (#1288), and image preview thumbnails (#1289).
 */
import { useState, useEffect, useMemo, useId, useRef, useCallback, type KeyboardEvent, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react'
import { FilePicker, type FilePickerItem } from './FilePicker'
import { AttachmentChip } from './AttachmentChip'
import { SlashCommandPicker } from './SlashCommandPicker'
import { ImageThumbnail } from './ImageThumbnail'
import type { SlashCommand, EvaluatorResultPayload } from '../store/types'
import { filterImageFiles } from '../utils/image-utils'
import { shouldCollapsePaste } from '@chroxy/store-core'
import { PastedTextChip } from './PastedTextChip'

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
}

type EvaluatorState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'result', result: EvaluatorResultPayload }
  | { kind: 'error', message: string }

export function InputBar({ onSend, onInterrupt, disabled, isBusy, isStreaming, placeholder, filePickerFiles, onFileTrigger, attachments, onRemoveAttachment, slashCommands, onSlashTrigger, onImagePaste, onImageDrop, imageAttachments, onRemoveImage, onFileAttach, controlledValue, onValueChange, sendOnEnter, voiceInput, onEvaluate, onLargePaste, pastedTextBlocks, onInspectPastedText, onRemovePastedText }: InputBarProps) {
  const [internalValue, setInternalValue] = useState('')
  const value = controlledValue !== undefined ? controlledValue : internalValue
  const setValue = onValueChange || setInternalValue
  const dictationStartRef = useRef(0)
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const shortcutsId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // #3068 — manual prompt evaluator state machine. Lives in InputBar because
  // applying a rewrite has to swap the textarea value and re-focus it.
  const [evaluatorState, setEvaluatorState] = useState<EvaluatorState>({ kind: 'idle' })

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
  const canSubmit = useMemo(() => {
    const hasText = value.trim().length > 0
    const hasAtts = (dedupedAttachments?.length ?? 0) > 0
    const hasImgs = (imageAttachments?.length ?? 0) > 0
    const hasPastes = (pastedTextBlocks?.length ?? 0) > 0
    return hasText || hasAtts || hasImgs || hasPastes
  }, [value, dedupedAttachments, imageAttachments, pastedTextBlocks])

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

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command picker keyboard handling
    if (pickerOpen) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePicker()
        return
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        if (filteredCommands.length > 0) {
          const idx = Math.min(selectedIndex, filteredCommands.length - 1)
          selectCommand(filteredCommands[idx]!.name)
        }
        return
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

    if (e.key === 'Enter') {
      if (sendOnEnter && !e.shiftKey) {
        e.preventDefault()
        send()
      } else if (!sendOnEnter && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        send()
      }
    } else if (e.key === 'Escape') {
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
  }, [pickerOpen, filePickerOpen, filteredFiles, fileSelectedIndex, selectFile, send, onInterrupt, closePicker, selectCommand, filteredCommands, selectedIndex, sendOnEnter, clearComposer])

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setValue(newValue)

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
  }, [slashCommands, pickerOpen, closePicker, onSlashTrigger, filePickerFiles, filePickerOpen, onFileTrigger])

  // Merge voice transcript into input value via effect (not during render)
  const prevTranscriptRef = useRef('')
  useEffect(() => {
    if (voiceInput?.isRecording && voiceInput.transcript && voiceInput.transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = voiceInput.transcript
      const prefix = value.slice(0, dictationStartRef.current)
      const separator = prefix.length > 0 && !prefix.endsWith(' ') ? ' ' : ''
      setValue(prefix + separator + voiceInput.transcript)
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

  const hasImages = imageAttachments && imageAttachments.length > 0

  return (
    <div
      className={`input-bar${dragging ? ' dragging' : ''}`}
      data-testid="input-bar"
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
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        disabled={disabled}
        placeholder={isBusy ? 'Type to send follow-up...' : placeholder}
        aria-label="Message input"
        aria-describedby={shortcutsId}
        rows={1}
      />
      <div className="input-bar-actions">
        {voiceInput?.isAvailable && (
          <button
            data-testid="mic-button"
            className={`btn-mic${voiceInput.isRecording ? ' recording' : ''}`}
            onClick={handleMicPress}
            disabled={disabled}
            type="button"
            aria-label={voiceInput.isRecording ? 'Stop recording' : 'Start voice input'}
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
