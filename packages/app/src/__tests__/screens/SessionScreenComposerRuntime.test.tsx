import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import renderer, { act } from 'react-test-renderer';
import { View, Text, TouchableOpacity } from 'react-native';
import { InputBar, type InputBarHandle } from '../../components/InputBar';
import { useDictationComposer } from '../../hooks/useDictationComposer';
import { ComposerRecoveryQueue, recoverRejectedComposer, formatPasteMarker, expandPasteMarkers, parseMemoryAppend, nextMessageId, applyInputAcknowledgement, beginInputDelivery } from '@chroxy/store-core';
import { toWireAttachments, MAX_ATTACHMENTS, type Attachment } from '../../utils/attachments';
const noop = () => { };
const styles: any = {};
let api: any;
let subscribers = new Set<(s: any) => void>();
const ackStore = createStore<any>(() => ({ activeSessionId: 's1', sessionStates: { s1: { inputDeliveries: {}, messages: [] } } }));
const appendMemory = jest.fn(() => true);
const useConnectionStore = { getState: () => ({ appendMemory, addMessage: noop }), subscribe: (cb: any) => { subscribers.add(cb); const un = ackStore.subscribe(cb); return () => { subscribers.delete(cb); un(); }; } };
let deliveryState: any;
let sent: any[] = [];
const sendInput = (text: any, attachments: any, options: any) => { sent.push({ text, attachments, options }); deliveryState.sessionStates.s1.inputDeliveries = beginInputDelivery(deliveryState.sessionStates.s1.inputDeliveries, options.clientMessageId, undefined, Date.now(), 's1'); return 'sent'; };
const baseProps = { onSend: noop, onInterrupt: noop, onKeyPress: noop, onClearTerminal: noop, enterToSend: true, onToggleEnterMode: noop, isStreaming: false, claudeReady: true, viewMode: 'chat' as const, hasTerminal: false, bottomPadding: 0 };
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { Alert } from 'react-native';
const launchWebTask = jest.fn();
// Focused native caller render: real InputBar, dictation hook, Zustand subscriptions
// and acknowledgement reducer. Only unrelated SessionScreen UI/network dependencies
// are replaced. Execute production callback bodies, never copies that can drift.
const source = fs.readFileSync(path.resolve(__dirname, '../../screens/SessionScreen.tsx'), 'utf8');
function section(start: string, end: string): string {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    if (a < 0 || b <= a)
        throw new Error(`Missing production caller section: ${start}`);
    return source.slice(a, b);
}
const body = `
  const composerReadiness={canSend:true};
  const streamingMessageId=null,isIdle=true,hasTerminal=false,webFeatures={available:true},sessionCwd='/tmp',viewMode='chat',isPlanPending=false;
  const addUserMessage=noop,clearPlanState=noop;
  const inputRef=useRef(null);
  useStore(ackStore,s=>s.sessionStates.s1.messages);
  const [sessions,setSessions]=useState([{sessionId:'s1'}]);
  const activeSessionId='s1';
  const isRecognizing=false, transcript='';
  const startListening=noop, stopListening=noop;
  ${section('  const [pendingAttachments,', '  const [showAttachSheet,')}
  ${section('  type PastedTextBlock =', '  const handleInspectPastedText =')}
  ${section('  const handleRemoveAttachment =', '  const handleKeyPress =')}
  ${section('  const addAttachment =', '  const handleCamera =')}
  ${section('  const handleSendImpl =', '  // Refresh the live implementation')}
  publishApi({addAttachment,handleSendImpl,setPendingAttachments,inputRef,pendingAttachments,pastedTextBlocks,pendingComposerSubmissionsRef,recoveredComposersRef,setSessions});
`;
const ui = `  return <View>      {composerRecovery && (
        <View style={styles.composerRecovery} testID="composer-recovery" accessibilityRole="alert">
          <Text style={styles.composerRecoveryText}>
            {composerRecoveryOriginalExists
              ? 'Message was not sent; the draft was kept for its original session.'
              : 'Message was not sent and its session closed; restore the kept draft here.'}
          </Text>
          <TouchableOpacity
            style={styles.composerRecoveryButton}
            onPress={restoreComposerRecovery}
            disabled={!activeSessionId
              || (composerRecoveryOriginalExists && activeSessionId !== composerRecovery.sessionId)
              || recoveryComposerOccupied || pendingAttachments.length > 0}
            accessibilityRole="button"
            accessibilityLabel={composerRecoveryOriginalExists ? 'Restore unsent draft' : 'Restore draft here'}
          >
            <Text style={styles.composerRecoveryButtonText}>
              {composerRecoveryOriginalExists ? 'Restore' : 'Restore here'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.composerRecoveryButton}
            onPress={() => {
              recoveredComposersRef.current.dismiss(composerRecovery.clientMessageId);
              setComposerRecovery(recoveredComposersRef.current.offer);
            }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss unsent draft"
          >
            <Text style={styles.composerRecoveryButtonText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}

<InputBar ref={inputRef} {...baseProps} onChangeText={handleChangeText} onValueChange={handleComposerValueChange} attachments={pendingAttachments as any} onRemoveAttachment={handleRemoveAttachment} pastedTextBlocks={pastedTextBlocks} onRemovePastedText={handleRemovePastedText}/></View>;`;
const javascript = ts.transpileModule(`function Host(){${body}${ui}}`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText;
const Host = new Function('React', 'useState', 'useRef', 'useCallback', 'useEffect', 'useStore', 'ackStore', 'View', 'Text', 'TouchableOpacity', 'InputBar', 'useDictationComposer', 'ComposerRecoveryQueue', 'recoverRejectedComposer', 'formatPasteMarker', 'expandPasteMarkers', 'parseMemoryAppend', 'nextMessageId', 'toWireAttachments', 'useConnectionStore', 'sendInput', 'noop', 'styles', 'publishApi', 'launchWebTask', 'Alert', 'baseProps', 'MAX_ATTACHMENTS', javascript + '; return Host;')(React, useState, useRef, useCallback, useEffect, useStore, ackStore, View, Text, TouchableOpacity, InputBar, useDictationComposer, ComposerRecoveryQueue, recoverRejectedComposer, formatPasteMarker, expandPasteMarkers, parseMemoryAppend, nextMessageId, toWireAttachments, useConnectionStore, sendInput, noop, styles, (value: any) => { api = value; }, launchWebTask, Alert, baseProps, MAX_ATTACHMENTS);
function mount() { subscribers.clear(); sent = []; deliveryState = { activeSessionId: 's1', sessionStates: { s1: { inputDeliveries: {}, messages: [] } } }; let tree: any; act(() => { ackStore.setState(deliveryState); tree = renderer.create(<Host />); }); return tree; }
function reject(id: string, status = 'rejected', retrySafe = true) {
    const msg = { type: 'input_ack', clientMessageId: id, sessionId: 's1', status, delivery: 'not_dispatched', retrySafe, dedupScope: 'process' };
    deliveryState = { ...deliveryState, sessionStates: { s1: { messages: [], inputDeliveries: applyInputAcknowledgement(deliveryState.sessionStates.s1.inputDeliveries, msg) } } };
    expect(deliveryState.sessionStates.s1.inputDeliveries[id]?.status).toBe(status);
    ackStore.setState(deliveryState);
}
const att = (id: string): Attachment => ({ id, type: 'image', name: id + '.png', uri: 'file:///tmp/' + id + '.png', mediaType: 'image/png', data: 'aGVsbG8=', size: 5 });
function submitAttachment(id: string) { act(() => api.setPendingAttachments([att(id)])); act(() => { if (api.handleSendImpl() !== true)
    throw new Error('Attachment-only caller refused real submission'); }); return sent[sent.length - 1].options.clientMessageId; }
const snapshot = (id: string, attachments: any[] = [], draft = 'rejected original') => ({ clientMessageId: id, sessionId: 's1', draft, attachments, pastedBlocks: [], isVoice: false });
const draft = (tree: any, text: string) => act(() => tree.root.findByProps({ testID: 'chat-message-input' }).props.onChangeText(text));
// Checks intentionally assert observed behavior; risk scenarios are followed by controls.
it('real chip button silent chip removal enables recovery without an extra text edit', () => {
    const t = mount();
    draft(t, 'original');
    act(() => api.handleSendImpl());
    const id = sent[0].options.clientMessageId;
    draft(t, 'PASTE\n'.repeat(30));
    act(() => reject(id));
    expect(t.root.findByProps({ accessibilityLabel: 'Restore unsent draft' }).props.disabled).toBe(true);
    act(() => t.root.findByProps({ testID: 'pasted-text-chip-remove-1' }).props.onPress());
    expect(api.inputRef.current.getValue()).toBe('');
    expect(api.pastedTextBlocks).toHaveLength(0);
    expect(t.root.findByProps({ accessibilityLabel: 'Restore unsent draft' }).props.disabled).toBe(false);
    draft(t, 'x');
    draft(t, '');
    expect(t.root.findByProps({ accessibilityLabel: 'Restore unsent draft' }).props.disabled).toBe(false);
    act(() => t.root.findByProps({ accessibilityLabel: 'Restore unsent draft' }).props.onPress());
    expect(api.inputRef.current.getValue()).toBe('original');
    expect(sent).toHaveLength(1);
    act(() => t.unmount());
});
it('batched correlated production-reducer rejection keeps A restored and B offered through a roster refresh', () => {
    const t = mount();
    const a = submitAttachment('A'), b = submitAttachment('B');
    expect(sent.map(x => x.text)).toEqual(['', '']);
    expect(sent.map(x => x.attachments[0].name)).toEqual(['A.png', 'B.png']);
    act(() => { reject(a); reject(b); });
    expect(api.pendingAttachments.map((x: any) => x.id)).toEqual(['A']);
    expect(api.recoveredComposersRef.current.offer.clientMessageId).toBe(b);
    expect(api.pendingComposerSubmissionsRef.current.size).toBe(0);
    // Only A owns the composer; B remains an actionable offer.
    const entries = Array.from((api.recoveredComposersRef.current as any).entries.values()) as any[];
    expect(entries.map(x => [x.snapshot.attachments[0].id, x.restored])).toEqual([['A', true], ['B', false]]);
    expect(t.root.findAllByProps({ testID: 'composer-recovery' }).length > 0).toBe(true);
    // A normal session_list replaces the roster array (identical IDs); production
    // effect must preserve A and B independently.
    act(() => api.setSessions([{ sessionId: 's1' }]));
    const refreshed = Array.from((api.recoveredComposersRef.current as any).entries.values()) as any[];
    expect(refreshed.map(x => x.snapshot.attachments[0].id)).toEqual(['A', 'B']);
    act(() => api.setSessions([]));
    expect(api.recoveredComposersRef.current.offer.clientMessageId).toBe(a);
    expect(api.recoveredComposersRef.current.offer.attachments[0].id).toBe('A');
    expect(sent).toHaveLength(2);
    act(() => t.unmount());
});
it('split commits control restores A and offers B without replacement', () => {
    const t = mount();
    const a = submitAttachment('A'), b = submitAttachment('B');
    act(() => reject(a));
    act(() => reject(b));
    expect(api.pendingAttachments.map((x: any) => x.id)).toEqual(['A']);
    expect(api.recoveredComposersRef.current.offer.clientMessageId).toBe(b);
    expect(api.recoveredComposersRef.current.offer.attachments[0].id).toBe('B');
    act(() => t.unmount());
});
it('same-batch nonempty draft control guards first restoration synchronously', () => {
    const t = mount();
    draft(t, 'A text');
    act(() => api.handleSendImpl());
    const a = sent[0].options.clientMessageId;
    draft(t, 'B text');
    act(() => api.handleSendImpl());
    const b = sent[1].options.clientMessageId;
    act(() => { reject(a); reject(b); });
    expect(api.inputRef.current.getValue()).toBe('A text');
    expect(api.recoveredComposersRef.current.offer.clientMessageId).toBe(b);
    act(() => t.unmount());
});
it('attachment burst through separate timer callbacks before React commit preserves both submissions', async () => {
    const t = mount();
    const a = submitAttachment('A'), b = submitAttachment('B');
    await act(async () => {
        await new Promise<void>(resolve => {
            setTimeout(() => reject(a), 0);
            setTimeout(() => { reject(b); resolve(); }, 0);
        });
    });
    expect(api.pendingAttachments.map((x: any) => x.id)).toEqual(['A']);
    expect(api.recoveredComposersRef.current.offer.clientMessageId).toBe(b);
    act(() => t.unmount());
});
it('sync external-store notification commits preserve two callbacks batched before commit', () => {
    const t = mount();
    const a = submitAttachment('A'), b = submitAttachment('B');
    act(() => { reject(a); reject(b); });
    expect(api.pendingAttachments.map((x: any) => x.id)).toEqual(['A']);
    expect(api.recoveredComposersRef.current.offer.clientMessageId).toBe(b);
    act(() => t.unmount());
});
// Direct ownership release paths: silent writes deliberately do not enter the
// real-user change handler, and must not leave an empty retained draft behind.
it.each(['paste', 'attachment', 'memory', 'web'])('releases an intentionally cleared restored %s owner before pruning', (kind) => {
    const tree = mount();
    let id: string;
    if (kind === 'attachment')
        id = submitAttachment('keep');
    else {
        draft(tree, kind === 'paste' ? 'PASTE\n'.repeat(30) : 'original');
        act(() => api.handleSendImpl());
        id = sent[0].options.clientMessageId;
    }
    act(() => reject(id));
    expect(api.recoveredComposersRef.current.hasWork).toBe(true);
    if (kind === 'paste')
        act(() => tree.root.findByProps({ testID: 'pasted-text-chip-remove-1' }).props.onPress());
    if (kind === 'attachment')
        act(() => tree.root.findByType(InputBar).props.onRemoveAttachment('keep'));
    if (kind === 'memory' || kind === 'web') {
        draft(tree, kind === 'memory' ? '# saved note' : '& cloud task');
        act(() => expect(api.handleSendImpl()).toBe(true));
    }
    expect(api.inputRef.current.getValue()).toBe('');
    expect(api.recoveredComposersRef.current.hasWork).toBe(false);
    act(() => api.setSessions([]));
    expect(api.recoveredComposersRef.current.offer).toBeNull();
    expect(sent).toHaveLength(1);
    act(() => tree.unmount());
});
it.each([['accepted', true], ['uncertain', true], ['rejected', false]])('never recovers %s with retrySafe=%s', (status, retrySafe) => {
    const tree = mount();
    const id = submitAttachment('keep');
    act(() => reject(id, status as string, retrySafe as boolean));
    expect(api.pendingAttachments).toHaveLength(0);
    expect(api.recoveredComposersRef.current.hasWork).toBe(false);
    expect(sent).toHaveLength(1);
    act(() => tree.unmount());
});
it('protects a newer asynchronous picker attachment before React commits', async () => {
    const tree = mount();
    draft(tree, 'original');
    act(() => api.handleSendImpl());
    const id = sent[0].options.clientMessageId;
    await act(async () => {
        await api.addAttachment(async () => att('newer'));
        reject(id);
    });
    expect(api.pendingAttachments.map((a: Attachment) => a.id)).toEqual(['newer']);
    expect(api.inputRef.current.getValue()).toBe('');
    expect(api.recoveredComposersRef.current.offer.draft).toBe('original');
    act(() => tree.root.findByType(InputBar).props.onRemoveAttachment('newer'));
    expect(tree.root.findByProps({ accessibilityLabel: 'Restore unsent draft' }).props.disabled).toBe(false);
    act(() => tree.root.findByProps({ accessibilityLabel: 'Restore unsent draft' }).props.onPress());
    expect(api.inputRef.current.getValue()).toBe('original');
    expect(sent).toHaveLength(1);
    act(() => tree.unmount());
});
it('clearing restored A leaves B actionable and never resends automatically', () => {
    const tree = mount();
    const a = submitAttachment('A'), b = submitAttachment('B');
    act(() => { reject(a); reject(b); });
    act(() => tree.root.findByType(InputBar).props.onRemoveAttachment('A'));
    expect(api.recoveredComposersRef.current.offer.clientMessageId).toBe(b);
    expect(tree.root.findByProps({ accessibilityLabel: 'Restore unsent draft' }).props.disabled).toBe(false);
    act(() => tree.root.findByProps({ accessibilityLabel: 'Restore unsent draft' }).props.onPress());
    expect(api.pendingAttachments.map((a: Attachment) => a.id)).toEqual(['B']);
    expect(api.recoveredComposersRef.current.offer).toBeNull();
    expect(sent).toHaveLength(2);
    act(() => tree.unmount());
});
it('removing the visible owner after origin pruning removes its empty offer', () => {
    const tree = mount();
    const id = submitAttachment('A');
    act(() => reject(id));
    act(() => api.setSessions([]));
    expect(api.recoveredComposersRef.current.offer.clientMessageId).toBe(id);
    act(() => tree.root.findByType(InputBar).props.onRemoveAttachment('A'));
    expect(api.recoveredComposersRef.current.hasWork).toBe(false);
    expect(tree.root.findAllByProps({ testID: 'composer-recovery' })).toHaveLength(0);
    act(() => tree.unmount());
});
