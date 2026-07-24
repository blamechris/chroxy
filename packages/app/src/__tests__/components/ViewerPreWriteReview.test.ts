/**
 * ViewerPreWriteReview (#6544, IDE P3.3 feature A — mobile) — the editable
 * pre-write diff surfaced inside the FileEditor.
 *
 * The app has no RN render harness (@testing-library/react-native is not a
 * dep), so — matching the repo's mobile convention (FileEditor.test.ts is a
 * source scan) — behavior is covered via a source scan pinning the wiring: it
 * reuses PreWriteDiffReview, pulls the input via requestPermissionInput, routes
 * `editedInput` through sendPermissionResponse on Approve (and drops it on
 * Deny), and FileEditor renders <ViewerPreWriteReview>.
 *
 * #6859: the pure correlation helpers (`pathMatchesViewer` /
 * `findPendingWriteForFile`) were hoisted into `@chroxy/store-core` and their
 * unit tests moved to `packages/store-core/src/pending-permissions.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('ViewerPreWriteReview — wiring (source scan)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/ViewerPreWriteReview.tsx'),
    'utf-8',
  );

  it('exports ViewerPreWriteReview and imports the correlation helpers from store-core (#6859)', () => {
    expect(source).toMatch(/export\s+function\s+ViewerPreWriteReview/);
    expect(source).toContain("import { findPendingWriteForFile } from '@chroxy/store-core'");
  });

  it('reuses the #6556 PreWriteDiffReview for the diff/hunk mechanics', () => {
    expect(source).toContain("import { PreWriteDiffReview, isReviewableTool } from './PreWriteDiffReview'");
    expect(source).toContain('<PreWriteDiffReview');
    expect(source).toContain('onEditedInputChange={setEditedInput}');
  });

  it('pulls the full tool input via requestPermissionInput (get_permission_input seam)', () => {
    expect(source).toContain('requestPermissionInput(requestId)');
  });

  it('routes editedInput through sendPermissionResponse on approve, and drops it on deny', () => {
    expect(source).toContain(
      "sendPermissionResponse(requestId, decision, decision === 'deny' ? null : editedInput)",
    );
  });

  it('resets the submit guard when the send did not go through (#6308 wsSend-false / disconnected)', () => {
    expect(source).toContain("sent !== 'sent'");
    expect(source).toContain('submittingRef.current = false');
    expect(source).toContain('setSubmitting(false)');
  });

  it('gates on features.ide (serverCapabilities.ide)', () => {
    expect(source).toContain('s.serverCapabilities?.ide');
    expect(source).toContain('if (!ideEnabled || !pending || !requestId) return null');
  });
});

// The High the first review caught: respond() used to re-mark the prompt with a
// display LABEL ('Approved'/'Denied') AFTER sendPermissionResponse had already
// stored the canonical decision TOKEN via markPromptAnsweredByRequestId, clobbering
// it. PermissionDetail renders the answered pill via `isDenied = answer === 'deny'`,
// so a 'Denied' LABEL (not === 'deny') renders a green "Allowed" pill for a denied
// write. Pin the token semantics so the label clobber can't come back (#6222/#6223).
describe('decision-token semantics (#6222/#6223)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/ViewerPreWriteReview.tsx'),
    'utf-8',
  );
  const permDetailSource = fs.readFileSync(
    path.resolve(__dirname, '../../components/PermissionDetail.tsx'),
    'utf-8',
  );
  // Mirrors PermissionDetail's pill predicate — kept coupled to real code by the
  // source assertion below — so the token-vs-label divergence is pinned, not invented.
  const pillIsDenied = (answer: string) => answer === 'deny';

  it('PermissionDetail still keys the denied pill off the exact decision token', () => {
    expect(permDetailSource).toContain("const isDenied = answer === 'deny'");
  });

  it('the token deny renders Denied, while a display label renders Allowed (the clobber bug)', () => {
    expect(pillIsDenied('deny')).toBe(true); // token → "Denied" pill
    expect(pillIsDenied('Denied')).toBe(false); // label → wrongly "Allowed" pill
    expect(pillIsDenied('Approved')).toBe(false);
  });

  it('respond passes the raw decision token and does NOT clobber it with a display label', () => {
    // The token reaches the store via sendPermissionResponse's own
    // markPromptAnsweredByRequestId(requestId, decision); respond must pass the raw
    // `decision` and must NOT re-mark via markPromptAnswered( with a display label.
    expect(source).toContain('sendPermissionResponse(requestId, decision,');
    expect(source).not.toContain('markPromptAnswered(');
  });
});

describe('FileEditor — mounts the pre-write review (source scan)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/FileEditor.tsx'),
    'utf-8',
  );

  it('imports and renders ViewerPreWriteReview for the open file', () => {
    expect(source).toContain("import { ViewerPreWriteReview } from './ViewerPreWriteReview'");
    expect(source).toContain('<ViewerPreWriteReview filePath={filePath} />');
  });
});
