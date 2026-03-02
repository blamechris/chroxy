/**
 * InputBar — auto-expanding textarea with send/interrupt and slash command picker.
 *
 * Enter for newline, Cmd/Ctrl+Enter to send, Escape to interrupt.
 * Supports file picker (@ trigger), attachment chips, and slash command picker (/ trigger).
 */
import { useState, useMemo, useId, useRef, useCallback, type KeyboardEvent, type ChangeEvent } from 'react'
import { FilePicker, type FilePickerItem } from './FilePicker'
import { AttachmentChip } from './AttachmentChip'
import { SlashCommandPicker } from './SlashCommandPicker'
import type { SlashCommand } from '../store/types'

export interface FileAttachment {
  path: string
  name: string
}

export interface InputBarProps {
  onSend: (text: string, attachments?: FileAttachment[]) => void
  onInterrupt: () => void
  disabled?: boolean
  isStreaming?: boolean
  placeholder?: string
  filePickerFiles?: FilePickerItem[] | null
  onFileTrigger?: () => void
  attachments?: FileAttachment[]
  onRemoveAttachment?: (path: string) => void
  slashCommands?: SlashCommand[]
  onSlashTrigger?: () => void
}

export function InputBar({ onSend, onInterrupt, disabled, isStreaming, placeholder, filePickerFiles, onFileTrigger, attachments, onRemoveAttachment, slashCommands, onSlashTrigger }: InputBarProps) {
  const [value, setValue] = useState('')
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const shortcutsId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
    setFilePickerOpen(false)
    setFileSelectedIndex(0)
  }, [value, triggerAtIdx])

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

  const send = useCallback(() => {
    const trimmed = value.trim()
    const hasAttachments = attachments && attachments.length > 0
    if (!trimmed && !hasAttachments) return
    if (hasAttachments) {
      onSend(trimmed, attachments)
    } else {
      onSend(trimmed)
    }
    setValue('')
    setFilePickerOpen(false)
    setFileSelectedIndex(0)
    setPickerOpen(false)
    setSelectedIndex(0)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, onSend, attachments])

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

    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onInterrupt()
    }
  }, [pickerOpen, filePickerOpen, filteredFiles, fileSelectedIndex, selectFile, send, onInterrupt, closePicker, selectCommand, filteredCommands, selectedIndex])

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

  const hasChips = attachments && attachments.length > 0

  return (
    <div className="input-bar" data-testid="input-bar">
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
          {attachments.map(att => (
            <AttachmentChip
              key={att.path}
              name={att.name}
              path={att.path}
              onRemove={() => onRemoveAttachment?.(att.path)}
            />
          ))}
        </div>
      )}
      <span id={shortcutsId} className="sr-only">
        Press Cmd/Ctrl+Enter to send, Escape to interrupt
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
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Message input"
        aria-describedby={shortcutsId}
        rows={1}
      />
      {isStreaming ? (
        <button
          data-testid="interrupt-button"
          className="btn-interrupt"
          onClick={onInterrupt}
          type="button"
          aria-label="Stop generation"
        >
          Stop
        </button>
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
  )
}
