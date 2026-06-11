import { useRef, useCallback, useEffect } from 'react';
import {
  shouldCollapsePaste,
  detectPasteFromDiff,
} from '@chroxy/store-core';

import type { InputBarHandle } from '../components/InputBar';

/**
 * Dictation + composer-change bookkeeping for SessionScreen (#5567).
 *
 * Owns the three composer refs that the voice-merge path coordinates:
 *
 * - `isDictationUpdateRef` — true for exactly one composer change: the echo of
 *   a programmatic dictation `setValue`. Used to distinguish "this change is our
 *   own transcript write" from "the user manually edited mid-dictation" so the
 *   anchor (`dictationStartRef`) isn't clobbered by our own write.
 * - `dictationStartRef` — index in the draft where the current dictation session
 *   began inserting; the transcript is spliced in after this offset.
 * - `usedVoiceRef` — whether the pending message originated (partly) from voice,
 *   read by the send path to tag the outgoing message `isVoice`.
 *
 * ## The wedge this hook closes (#5567)
 *
 * Pre-#5566, the InputBar's `setValue` fired `onChangeText`, so the programmatic
 * dictation write produced its own `onChangeText` echo and `handleChangeText`
 * always cleared `isDictationUpdateRef` on the very next tick. After #5566,
 * `InputBarHandle.setValue` is **silent** — it does NOT fire `onChangeText`. So
 * the flag set just before the transcript write is now only ever cleared by a
 * *subsequent real user keystroke*. If dictation stops or errors after a
 * transcript arrived but before the user typed again, the flag stays stuck
 * `true`. The next genuine keystroke then hits the `isDictationUpdateRef` branch
 * in `handleChangeText` and is misread as "our own dictation echo" — the manual-
 * edit anchor re-point is skipped, corrupting paste detection / anchoring for
 * that input.
 *
 * The fix: clear `isDictationUpdateRef` on every dictation teardown path —
 * `handleMicPress` stop, speech error, the `isRecognizing → false` transition,
 * and unmount — so a stale `true` can never bleed into the next genuine input.
 */

export interface UseDictationComposerParams {
  /** Imperative handle for the InputBar composer draft (#5556). */
  inputRef: React.RefObject<InputBarHandle | null>;
  /** Whether the speech recogniser is currently active. */
  isRecognizing: boolean;
  /** Latest transcript text from the recogniser (empty when none). */
  transcript: string;
  /** Speech-recognition error string, or null. */
  speechError: string | null;
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
  /** Mic toggle: start when idle, stop (and clear the dictation flag) when active. */
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
    speechError,
    startListening,
    stopListening,
    onPasteCollapsed,
  } = params;

  // True for exactly one composer change — the echo of a programmatic dictation
  // write. See the module doc for why this must be cleared on every teardown.
  const isDictationUpdateRef = useRef(false);
  // Index where the current dictation session began inserting (#5556).
  const dictationStartRef = useRef(0);
  // Whether the pending message used voice (read by the send path).
  const usedVoiceRef = useRef(false);

  // Keep the latest paste callback without re-creating handleChangeText, so the
  // InputBar's onChangeText identity stays stable across streaming re-renders.
  const onPasteCollapsedRef = useRef(onPasteCollapsed);
  onPasteCollapsedRef.current = onPasteCollapsed;

  const handleChangeText = useCallback((text: string, prev: string) => {
    if (!isDictationUpdateRef.current && isRecognizing) {
      // User manually edited text during dictation — update anchor point
      dictationStartRef.current = text.length;
    }
    isDictationUpdateRef.current = false;

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

  // Voice input: toggle start/stop and merge transcript into input text. On stop
  // we MUST clear `isDictationUpdateRef` — a transcript may have set it true and,
  // since `setValue` is silent post-#5556, nothing else will clear it before the
  // next genuine keystroke (#5567).
  const handleMicPress = useCallback(() => {
    if (isRecognizing) {
      isDictationUpdateRef.current = false;
      stopListening();
    } else {
      dictationStartRef.current = (inputRef.current?.getValue() ?? '').length;
      startListening();
    }
  }, [isRecognizing, startListening, stopListening, inputRef]);

  // Merge each transcript into the draft after the dictation anchor. Sets the
  // dictation flag so the (silent) write isn't mistaken for a manual edit, and
  // marks the message as voice-originated for the send path.
  useEffect(() => {
    if (isRecognizing && transcript) {
      const current = inputRef.current?.getValue() ?? '';
      const prefix = current.slice(0, dictationStartRef.current);
      const separator = prefix.length > 0 && !prefix.endsWith(' ') ? ' ' : '';
      isDictationUpdateRef.current = true;
      usedVoiceRef.current = true;
      inputRef.current?.setValue(prefix + separator + transcript);
    }
  }, [transcript]); // eslint-disable-line react-hooks/exhaustive-deps -- only react to transcript changes

  // #5567 — clear the dictation flag whenever a speech error surfaces. The spec
  // sequence (error → end) can stop the recogniser after a transcript already
  // flipped the flag true; without this the stale flag wedges the next input.
  useEffect(() => {
    if (speechError) {
      isDictationUpdateRef.current = false;
    }
  }, [speechError]);

  // #5567 — clear the dictation flag whenever recognition stops for ANY reason
  // (user stop, silence timeout, hard error, system interruption). This is the
  // catch-all: the flag is only meaningful while a transcript write is pending
  // an echo, and once the recogniser is no longer active there is no pending
  // dictation write to attribute the next change to.
  useEffect(() => {
    if (!isRecognizing) {
      isDictationUpdateRef.current = false;
    }
  }, [isRecognizing]);

  // #5567 — defensive unmount clear. Refs survive across renders but not across
  // re-mounts; this keeps the teardown contract explicit and self-documenting.
  useEffect(() => {
    return () => {
      isDictationUpdateRef.current = false;
    };
  }, []);

  const consumeUsedVoice = useCallback(() => {
    const used = usedVoiceRef.current;
    usedVoiceRef.current = false;
    return used;
  }, []);

  return { handleChangeText, handleMicPress, consumeUsedVoice };
}
