import { useRef, useCallback, useEffect } from 'react';
import {
  shouldCollapsePaste,
  detectPasteFromDiff,
} from '@chroxy/store-core';

import type { InputBarHandle } from '../components/InputBar';

/**
 * Dictation + composer-change bookkeeping for SessionScreen (#5573).
 *
 * Owns the two composer refs that the voice-merge path coordinates:
 *
 * - `dictationStartRef` — index in the draft where the current dictation session
 *   began inserting; the transcript is spliced in after this offset. Every user
 *   edit during recognition re-anchors this to `text.length` so the next
 *   transcript appends after the typed text rather than overwriting it.
 * - `usedVoiceRef` — whether the pending message originated (partly) from voice,
 *   read by the send path to tag the outgoing message `isVoice`.
 *
 * ## Why there is no `isDictationUpdateRef` flag (#5573)
 *
 * Pre-#5566, the InputBar's `setValue` fired `onChangeText`, so the programmatic
 * transcript write produced its own `onChangeText` echo. The hook carried an
 * `isDictationUpdateRef` flag — set `true` just before each transcript write —
 * to recognise that echo and skip re-anchoring on it (otherwise our own write
 * would have clobbered the anchor). That flag needed elaborate teardown clearing
 * (#5567) to avoid wedging stale `true` across a recogniser stop.
 *
 * Since #5566, `InputBarHandle.setValue` is **silent** — it writes the draft
 * directly and does NOT fire `onChangeText`. The only path that reaches
 * `handleChangeText` is now a real user keystroke. There is no programmatic echo
 * left to suppress, so the flag (and its four teardown effects) was dead code
 * that actively caused the #5573 bug: a manual edit typed mid-recognition landed
 * on a stuck-`true` flag and was misread as "our own write", so the re-anchor
 * was skipped and the next transcript spliced over the typed text.
 *
 * Removing the flag means every `onChangeText` during recognition is treated as
 * what it always is now — a user edit — and unconditionally re-anchors.
 */

export interface UseDictationComposerParams {
  /** Imperative handle for the InputBar composer draft (#5556). */
  inputRef: React.RefObject<InputBarHandle | null>;
  /** Whether the speech recogniser is currently active. */
  isRecognizing: boolean;
  /** Latest transcript text from the recogniser (empty when none). */
  transcript: string;
  /** Begin a recogniser session. */
  startListening: () => void;
  /** Stop the recogniser session. */
  stopListening: () => void;
  /**
   * Called when a composer change is detected as a paste large enough to
   * collapse. The host owns the pasted-block id counter + block state (it must
   * survive across this hook and reset on send), so the host assigns the id,
   * formats the marker, writes it back into the draft via `inputRef.setValue`,
   * and records the original content. `prefix`/`suffix` are the draft text on
   * either side of the inserted span.
   */
  onPasteCollapsed: (inserted: string, prefix: string, suffix: string) => void;
}

export interface UseDictationComposerReturn {
  /** `onChangeText(next, prev)` handler for the InputBar. */
  handleChangeText: (text: string, prev: string) => void;
  /** Mic toggle: start the recogniser when idle, stop it when active. */
  handleMicPress: () => void;
  /**
   * Read-and-reset the "used voice" flag for the send path. Returns whether the
   * pending message used voice, then clears the flag.
   */
  consumeUsedVoice: () => boolean;
}

export function useDictationComposer(
  params: UseDictationComposerParams,
): UseDictationComposerReturn {
  const {
    inputRef,
    isRecognizing,
    transcript,
    startListening,
    stopListening,
    onPasteCollapsed,
  } = params;

  // Index where the current dictation session began inserting (#5556).
  const dictationStartRef = useRef(0);
  // Whether the pending message used voice (read by the send path).
  const usedVoiceRef = useRef(false);

  // Keep the latest paste callback without re-creating handleChangeText, so the
  // InputBar's onChangeText identity stays stable across streaming re-renders.
  const onPasteCollapsedRef = useRef(onPasteCollapsed);
  onPasteCollapsedRef.current = onPasteCollapsed;

  const handleChangeText = useCallback((text: string, prev: string) => {
    // Every `onChangeText` is a real user keystroke (the dictation write goes
    // through the silent `setValue` since #5566). So while recognition is active
    // this IS a manual mid-dictation edit — re-anchor so the next transcript
    // appends after the typed text instead of overwriting it (#5573).
    if (isRecognizing) {
      dictationStartRef.current = text.length;
    }

    // Paste detection — RN `TextInput` has no native paste event, so we detect
    // by diffing prev→next on each `onChangeText` and feeding the inserted span
    // through the shared `shouldCollapsePaste` predicate (covers both the char
    // and the line thresholds).
    if (text.length > prev.length) {
      const diff = detectPasteFromDiff(prev, text);
      if (diff && shouldCollapsePaste(diff.inserted)) {
        onPasteCollapsedRef.current(diff.inserted, diff.prefix, diff.suffix);
      }
    }
  }, [isRecognizing]);

  // Voice input: toggle start/stop and merge transcript into input text.
  const handleMicPress = useCallback(() => {
    if (isRecognizing) {
      stopListening();
    } else {
      dictationStartRef.current = (inputRef.current?.getValue() ?? '').length;
      startListening();
    }
  }, [isRecognizing, startListening, stopListening, inputRef]);

  // Merge each transcript into the draft after the dictation anchor. The write
  // goes through the silent `setValue` (#5566), so it never echoes back through
  // `handleChangeText` as a spurious manual edit. Marks the message as
  // voice-originated for the send path.
  useEffect(() => {
    if (isRecognizing && transcript) {
      const current = inputRef.current?.getValue() ?? '';
      const prefix = current.slice(0, dictationStartRef.current);
      const separator = prefix.length > 0 && !prefix.endsWith(' ') ? ' ' : '';
      usedVoiceRef.current = true;
      inputRef.current?.setValue(prefix + separator + transcript);
    }
  }, [transcript]); // eslint-disable-line react-hooks/exhaustive-deps -- only react to transcript changes

  const consumeUsedVoice = useCallback(() => {
    const used = usedVoiceRef.current;
    usedVoiceRef.current = false;
    return used;
  }, []);

  return { handleChangeText, handleMicPress, consumeUsedVoice };
}
