import * as fs from 'fs';
import * as path from 'path';

// The actual InputBar/hook render test and shared queue tests execute behavior.
// These short booleans additionally pin SessionScreen's wiring to those paths.
const source = fs.readFileSync(path.resolve(__dirname, '../../screens/SessionScreen.tsx'), 'utf8');
const restore = source.slice(source.indexOf('const restoreComposerSubmission ='), source.indexOf('const composerRecoveryOriginalExists ='));
const send = source.slice(source.indexOf('const isVoice = consumeUsedVoice()'), source.indexOf('// #6774'));
const input = source.slice(source.indexOf('const handleComposerDraftChange ='), source.indexOf('const handleRemovePastedText ='));

it('keeps native recovery guarded and restores paste allocation and voice only inside successful restoration', () => {
  expect(restore.indexOf('return false;') < restore.indexOf('restoreUsedVoice(submission.isVoice)')).toBe(true);
  expect(/pastedTextNextIdRef\.current = Math\.max\(0, \.\.\.submission\.pastedBlocks\.map\(block => block\.id\)\)/.test(restore)).toBe(true);
  expect(/recoveredComposersRef\.current\.retain\(submission, true\)/.test(restore)).toBe(true);
  expect(/isVoice,/.test(send)).toBe(true);
  expect(/dismiss\(restoredComposerOwnerRef\.current\.clientMessageId\)/.test(send)).toBe(true);
});

it('connects local InputBar edits to the recovery occupancy observer without owning draft text in screen state', () => {
  expect(/onDraftChange: handleComposerDraftChange/.test(input)).toBe(true);
  expect(/setRecoveryComposerOccupied\(text\.length > 0\)/.test(input)).toBe(true);
  expect(/onChangeText=\{handleChangeText\}/.test(source)).toBe(true);
  expect(/\|\| recoveryComposerOccupied \|\| pendingAttachments\.length > 0/.test(source)).toBe(true);
});
