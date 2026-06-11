/**
 * #5567 — `useDictationComposer` clears `isDictationUpdateRef` on every
 * dictation teardown path.
 *
 * The dictation merge effect sets a private `isDictationUpdateRef = true` just
 * before writing the transcript into the composer via the InputBar's imperative
 * `setValue`. Pre-#5566 that programmatic write fired `onChangeText`, which
 * cleared the flag on the next tick. Since #5566 `setValue` is **silent**, so
 * the flag is only ever cleared by a *subsequent real user keystroke*. If
 * dictation stops or errors after a transcript arrived but before the user
 * types again, the flag wedges `true` and the next genuine keystroke is
 * mis-attributed as "our own dictation echo" — the manual-edit anchor re-point
 * (`dictationStartRef = text.length`) is skipped and paste/anchor behaviour is
 * corrupted.
 *
 * The flag is private, so these tests observe its EFFECT. `handleChangeText`
 * only runs the manual-edit re-anchor when the flag is false AND recognition is
 * active. So: drive a teardown, then start a fresh cycle, type mid-dictation,
 * and assert the next transcript splices at the user's edited length. That
 * holds only if the flag was cleared during teardown.
 *
 * Each teardown path is isolated:
 *  - silence-end stop (isRecognizing → false with NO mic tap) → catch-all effect
 *  - speech error (error → end spec sequence)               → error effect
 *  - explicit user stop via handleMicPress                  → mic-stop clear
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
 * the speech hook — `isRecognizing` / `transcript` / `speechError`).
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
  speechError: null,
  startListening: () => {},
  stopListening: () => {},
  onPasteCollapsed: () => {},
  ...overrides,
});

describe('useDictationComposer (#5567 dictation flag teardown)', () => {
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

  it('clears the flag on silence-end stop (no mic tap) — later mid-dictation edit re-anchors', () => {
    // Catch-all teardown: isRecognizing flips false WITHOUT handleMicPress (a
    // silence-triggered `end`). If the flag stayed stuck, the next recognising
    // cycle's mid-dictation manual edit would NOT re-anchor and the following
    // transcript would overwrite the typed text instead of appending.
    const inputRef = makeInputRef('');
    const props = (o: Partial<HarnessProps> = {}) => baseProps({ inputRef, ...o });
    const h = renderHarness(props());

    // Cycle 1: start → transcript (flag := true).
    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));
    h.update(props({ isRecognizing: true, transcript: 'one' }));
    expect(inputRef.current!.getValue()).toBe('one');

    // Silence-end: recogniser stops on its own, no keystroke to clear the flag.
    h.update(props({ isRecognizing: false, transcript: 'one' }));

    // Cycle 2: fresh start, then the user types mid-dictation. This must
    // re-anchor (flag was cleared) so the next transcript appends after it.
    act(() => { h.api.current!.handleMicPress(); }); // anchors at length 3 ('one')
    h.update(props({ isRecognizing: true }));
    inputRef.current!.setValue('one typed');
    act(() => { h.api.current!.handleChangeText('one typed', 'one'); }); // re-anchor to 9
    h.update(props({ isRecognizing: true, transcript: 'voice' }));
    expect(inputRef.current!.getValue()).toBe('one typed voice');
  });

  it('clears the flag on speech error (error → end) — later mid-dictation edit re-anchors', () => {
    const inputRef = makeInputRef('');
    const props = (o: Partial<HarnessProps> = {}) => baseProps({ inputRef, ...o });
    const h = renderHarness(props());

    // Cycle 1: start → transcript (flag := true).
    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));
    h.update(props({ isRecognizing: true, transcript: 'draft' }));
    expect(inputRef.current!.getValue()).toBe('draft');

    // Spec sequence: error surfaces, recogniser stops.
    h.update(props({ isRecognizing: false, transcript: 'draft', speechError: 'no-speech' }));

    // Cycle 2: fresh start (error cleared), mid-dictation manual edit re-anchors.
    act(() => { h.api.current!.handleMicPress(); }); // anchors at length 5 ('draft')
    h.update(props({ isRecognizing: true, speechError: null }));
    inputRef.current!.setValue('draft edit');
    act(() => { h.api.current!.handleChangeText('draft edit', 'draft'); }); // re-anchor to 10
    h.update(props({ isRecognizing: true, speechError: null, transcript: 'said' }));
    expect(inputRef.current!.getValue()).toBe('draft edit said');
  });

  it('clears the flag on explicit user stop via handleMicPress', () => {
    // Same wedge but torn down by an explicit mic tap (the stop branch).
    const inputRef = makeInputRef('');
    const props = (o: Partial<HarnessProps> = {}) => baseProps({ inputRef, ...o });
    const h = renderHarness(props());

    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));
    h.update(props({ isRecognizing: true, transcript: 'hi' }));
    act(() => { h.api.current!.handleMicPress(); }); // explicit user stop
    h.update(props({ isRecognizing: false, transcript: 'hi' }));

    act(() => { h.api.current!.handleMicPress(); }); // anchors at length 2 ('hi')
    h.update(props({ isRecognizing: true }));
    inputRef.current!.setValue('hi more');
    act(() => { h.api.current!.handleChangeText('hi more', 'hi'); }); // re-anchor to 7
    h.update(props({ isRecognizing: true, transcript: 'voice' }));
    expect(inputRef.current!.getValue()).toBe('hi more voice');
  });

  it('paste detection fires on genuine input after a dictation stop', () => {
    const inputRef = makeInputRef('');
    const onPasteCollapsed = jest.fn();
    const props = (o: Partial<HarnessProps> = {}) =>
      baseProps({ inputRef, onPasteCollapsed, ...o });

    const h = renderHarness(props());

    // Dictation produced a transcript (flag := true), then stopped (silence end)
    // with no intervening keystroke.
    act(() => { h.api.current!.handleMicPress(); });
    h.update(props({ isRecognizing: true }));
    h.update(props({ isRecognizing: true, transcript: 'note' }));
    h.update(props({ isRecognizing: false, transcript: 'note' }));

    // The user pastes a large block as their next genuine input. Paste detection
    // must fire — the stale flag must not break the anchor path that precedes it.
    const big = 'note' + '\n'.repeat(40) + 'pasted-tail';
    act(() => { h.api.current!.handleChangeText(big, 'note'); });

    expect(onPasteCollapsed).toHaveBeenCalledTimes(1);
    const [inserted] = onPasteCollapsed.mock.calls[0];
    expect(inserted).toContain('pasted-tail');
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
