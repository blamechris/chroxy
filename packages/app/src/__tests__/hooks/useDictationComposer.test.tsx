/**
 * #5573 — `useDictationComposer` re-anchors around mid-recognition manual edits.
 *
 * The dictation merge effect splices each transcript into the composer after a
 * `dictationStartRef` anchor, via the InputBar's imperative `setValue`. Since
 * #5566 that `setValue` is **silent** — it writes the draft directly and never
 * fires `onChangeText`. So the ONLY thing that reaches `handleChangeText` is a
 * real user keystroke.
 *
 * Pre-#5573 the hook carried an `isDictationUpdateRef` flag (set true before
 * each transcript write) to recognise the programmatic echo and skip
 * re-anchoring on it. With the echo gone (#5566) that flag was dead code that
 * actively broke the mid-recognition edit case: a transcript flipped the flag
 * true, the user typed while still recognising, `handleChangeText` saw the stale
 * `true` and SKIPPED the re-anchor, and the next transcript spliced over the
 * typed text. #5573 removes the flag, so every `onChangeText` during recognition
 * re-anchors unconditionally and the typed text is preserved.
 *
 * These tests observe behaviour through the InputBar handle (the flag was always
 * private). The headline test is the exact issue sequence:
 *   recognising → partial transcript merged → user types mid-recognition →
 *   next transcript arrives → BOTH the typed text and the new transcript present,
 *   correctly ordered.
 *
 * No `@testing-library/react-native` in this repo — we drive the hook through a
 * controllable react-test-renderer harness (same pattern as
 * `useSpeechRecognition.test.ts`).
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';

import {
  useDictationComposer,
  type UseDictationComposerParams,
  type UseDictationComposerReturn,
} from '../../hooks/useDictationComposer';
import type { InputBarHandle } from '../../components/InputBar';

/** Minimal in-memory stand-in for the InputBar imperative handle (#5556). */
function makeInputRef(initial = ''): React.RefObject<InputBarHandle | null> {
  let value = initial;
  const handle: InputBarHandle = {
    focus: () => {},
    getValue: () => value,
    // Silent programmatic write — does NOT call onChangeText (mirrors #5566).
    setValue: (next: string) => { value = next; },
    clear: () => { value = ''; },
  };
  return { current: handle };
}

type HarnessProps = UseDictationComposerParams;

/**
 * Render the hook in a controllable harness. `api.current` exposes the hook's
 * return so the test can drive `handleChangeText` / `handleMicPress`;
 * `update(props)` re-renders with fresh params (simulating prop changes from
 * the speech hook — `isRecognizing` / `transcript`).
 */
function renderHarness(initialProps: HarnessProps) {
  const apiRef: { current: UseDictationComposerReturn | null } = { current: null };

  function Harness(props: HarnessProps) {
    apiRef.current = useDictationComposer(props);
    return null;
  }

  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Harness {...initialProps} />);
  });

  return {
    api: apiRef,
    update: (props: HarnessProps) => {
      act(() => { tree.update(<Harness {...props} />); });
    },
    unmount: () => { act(() => { tree.unmount(); }); },
  };
}

const baseProps = (overrides: Partial<HarnessProps> = {}): HarnessProps => ({
  inputRef: makeInputRef(),
  isRecognizing: false,
  transcript: '',
  startListening: () => {},
  stopListening: () => {},
  onPasteCollapsed: () => {},
  ...overrides,
});

/**
 * Simulate a real user keystroke the way the InputBar does: write the draft via
 * the handle (the native TextInput's own state) AND fire `handleChangeText`
 * with (next, prev) — exactly the pair InputBar passes up on each keypress.
 */
function typeInto(
  inputRef: React.RefObject<InputBarHandle | null>,
  api: { current: UseDictationComposerReturn | null },
  next: string,
) {
  const prev = inputRef.current!.getValue();
  inputRef.current!.setValue(next);
  act(() => { api.current!.handleChangeText(next, prev); });
}

describe('useDictationComposer (#5573 mid-recognition re-anchor)', () => {
  it('handleMicPress starts when idle and stops when active', () => {
    const startListening = jest.fn();
    const stopListening = jest.fn();
    const inputRef = makeInputRef('hello');

    const h = renderHarness(baseProps({ inputRef, startListening, stopListening }));
    act(() => { h.api.current!.handleMicPress(); });
    expect(startListening).toHaveBeenCalledTimes(1);
    expect(stopListening).not.toHaveBeenCalled();

    // Now recognising — mic press should stop.
    h.update(baseProps({ inputRef, startListening, stopListening, isRecognizing: true }));
    act(() => { h.api.current!.handleMicPress(); });
    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  it('merges each transcript into the draft after the dictation anchor', () => {
    const inputRef = makeInputRef('');
    const props = (o: Partial<HarnessProps> = {}) => baseProps({ inputRef, ...o });
    const h = renderHarness(props());

    // Start dictation (anchors at draft length 0).
    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));

    // Transcript arrives → merged into the empty draft.
    h.update(props({ isRecognizing: true, transcript: 'hello world' }));
    expect(inputRef.current!.getValue()).toBe('hello world');
  });

  // ── The #5573 headline: mid-recognition manual edit must survive ──────────
  it('preserves a manual edit typed mid-recognition and anchors the next transcript AFTER it', () => {
    const inputRef = makeInputRef('');
    const props = (o: Partial<HarnessProps> = {}) => baseProps({ inputRef, ...o });
    const h = renderHarness(props());

    // 1. Start dictation (anchor := 0).
    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));

    // 2. A partial transcript is merged into the composer.
    h.update(props({ isRecognizing: true, transcript: 'hello' }));
    expect(inputRef.current!.getValue()).toBe('hello');

    // 3. The user types mid-recognition (still recognising) — appends ' there'.
    //    This MUST re-anchor dictationStartRef to the new length.
    typeInto(inputRef, h.api, 'hello there');

    // 4. The NEXT transcript arrives. It must splice AFTER the typed edit, not
    //    overwrite it. Pre-#5573 the stale flag skipped the re-anchor and this
    //    would have collapsed to just 'bye'.
    h.update(props({ isRecognizing: true, transcript: 'bye' }));

    const result = inputRef.current!.getValue();
    expect(result).toBe('hello there bye');
    // Both the typed text and the new transcript are present and ordered.
    expect(result).toContain('hello there');
    expect(result.indexOf('there')).toBeLessThan(result.indexOf('bye'));
  });

  // ── Negative control: the failing-before behaviour, asserted as a guard ────
  it('a mid-recognition edit that does NOT re-anchor would lose the typed text (control)', () => {
    // Drives the merge math directly to demonstrate WHY re-anchoring matters:
    // if the anchor is left at the pre-edit offset (0), the next transcript's
    // prefix is empty and the typed text is overwritten. The production hook
    // avoids this by re-anchoring on every keystroke (asserted in the test
    // above); here we confirm the stale-anchor path is genuinely lossy.
    const draft = 'hello there';
    const staleAnchor = 0;   // anchor NOT moved after the manual edit
    const freshAnchor = draft.length; // anchor moved to the edited length

    const merge = (anchor: number, transcript: string) => {
      const prefix = draft.slice(0, anchor);
      const separator = prefix.length > 0 && !prefix.endsWith(' ') ? ' ' : '';
      return prefix + separator + transcript;
    };

    // Stale anchor: typed text is lost.
    expect(merge(staleAnchor, 'bye')).toBe('bye');
    // Fresh (re-anchored): typed text preserved, transcript appended.
    expect(merge(freshAnchor, 'bye')).toBe('hello there bye');
  });

  it('re-anchors after a dictation stop so a later mid-dictation edit is preserved', () => {
    // Cross-cycle guard (covers the old #5567 teardown concern): a transcript in
    // cycle 1, then the recogniser stops on its own (silence end) with no
    // keystroke, then a fresh cycle where the user types mid-dictation. The edit
    // must re-anchor and the next transcript must append after it.
    const inputRef = makeInputRef('');
    const props = (o: Partial<HarnessProps> = {}) => baseProps({ inputRef, ...o });
    const h = renderHarness(props());

    // Cycle 1: start → transcript.
    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));
    h.update(props({ isRecognizing: true, transcript: 'one' }));
    expect(inputRef.current!.getValue()).toBe('one');

    // Silence-end: recogniser stops on its own, no keystroke.
    h.update(props({ isRecognizing: false, transcript: 'one' }));

    // Cycle 2: fresh start (anchors at length 3), user types mid-dictation.
    act(() => { h.api.current!.handleMicPress(); }); // anchors at length 3 ('one')
    h.update(props({ isRecognizing: true }));
    typeInto(inputRef, h.api, 'one typed'); // re-anchor to 9
    h.update(props({ isRecognizing: true, transcript: 'voice' }));
    expect(inputRef.current!.getValue()).toBe('one typed voice');
  });

  it('paste detection fires on genuine input after a dictation stop', () => {
    const inputRef = makeInputRef('');
    const onPasteCollapsed = jest.fn();
    const props = (o: Partial<HarnessProps> = {}) =>
      baseProps({ inputRef, onPasteCollapsed, ...o });

    const h = renderHarness(props());

    // Dictation produced a transcript, then stopped (silence end) with no
    // intervening keystroke.
    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));
    h.update(props({ isRecognizing: true, transcript: 'note' }));
    h.update(props({ isRecognizing: false, transcript: 'note' }));

    // The user pastes a large block as their next genuine input. Paste detection
    // must fire normally.
    const big = 'note' + '\n'.repeat(40) + 'pasted-tail';
    act(() => { h.api.current!.handleChangeText(big, 'note'); });

    expect(onPasteCollapsed).toHaveBeenCalledTimes(1);
    const [inserted] = onPasteCollapsed.mock.calls[0];
    expect(inserted).toContain('pasted-tail');
  });

  it('does NOT re-anchor when a change arrives while not recognising', () => {
    // Guard the `isRecognizing` gate: an edit made when the recogniser is idle
    // must leave the anchor untouched, so when dictation next starts it anchors
    // from handleMicPress (current draft length), not a stray mid-edit value.
    const inputRef = makeInputRef('');
    const props = (o: Partial<HarnessProps> = {}) => baseProps({ inputRef, ...o });
    const h = renderHarness(props());

    // User types while idle (not recognising) — no anchor move expected.
    typeInto(inputRef, h.api, 'typed while idle');

    // Start dictation: handleMicPress anchors at the CURRENT draft length.
    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));

    // Transcript appends after the full idle-typed draft.
    h.update(props({ isRecognizing: true, transcript: 'spoken' }));
    expect(inputRef.current!.getValue()).toBe('typed while idle spoken');
  });

  it('consumeUsedVoice reports voice usage once then resets', () => {
    const inputRef = makeInputRef('');
    const props = (o: Partial<HarnessProps> = {}) => baseProps({ inputRef, ...o });
    const h = renderHarness(props());

    // No voice yet.
    expect(h.api.current!.consumeUsedVoice()).toBe(false);

    // A transcript merge sets usedVoiceRef.
    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));
    h.update(props({ isRecognizing: true, transcript: 'spoken' }));

    expect(h.api.current!.consumeUsedVoice()).toBe(true);
    // Second read resets to false.
    expect(h.api.current!.consumeUsedVoice()).toBe(false);
  });
});
