/**
 * ViewerPreWriteReview (#6544, IDE P3.3 feature A — mobile) — the editable
 * pre-write diff surfaced inside the FileEditor.
 *
 * The app has no RN render harness (@testing-library/react-native is not a
 * dep), so — matching the repo's mobile convention (FileEditor.test.ts is a
 * source scan) — behavior is covered two ways:
 *   1. Pure-logic tests of the correlation helpers (pathMatchesViewer /
 *      findPendingWriteForFile): a pending write for the OPEN file is found;
 *      the no-match / resolved(answered) / expired / non-reviewable gates.
 *   2. A source scan pinning the wiring: it reuses PreWriteDiffReview, pulls the
 *      input via requestPermissionInput, routes `editedInput` through
 *      sendPermissionResponse on Approve (and drops it on Deny), and FileEditor
 *      renders <ViewerPreWriteReview>.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from '@chroxy/store-core';
import { pathMatchesViewer, findPendingWriteForFile } from '../../components/ViewerPreWriteReview';

const FILE = '/home/dev/project/src/app.ts';

function editPrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'perm-1',
    type: 'prompt',
    content: 'Edit: change app.ts',
    tool: 'Edit',
    requestId: 'req-1',
    toolInput: { file_path: FILE, old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
    expiresAt: Date.now() + 60_000,
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessage;
}

describe('pathMatchesViewer', () => {
  it('matches identical absolute paths', () => {
    expect(pathMatchesViewer('/a/b/c.ts', '/a/b/c.ts')).toBe(true);
  });
  it('tail-matches an absolute file_path against a workspace-relative selection', () => {
    expect(pathMatchesViewer('/root/pkg/src/x.ts', 'src/x.ts')).toBe(true);
    expect(pathMatchesViewer('/root/pkg/src/x.ts', './src/x.ts')).toBe(true);
  });
  it('does not match unrelated files or when either side is empty', () => {
    expect(pathMatchesViewer('/a/b/x.ts', '/a/b/y.ts')).toBe(false);
    expect(pathMatchesViewer(null, '/a/b/x.ts')).toBe(false);
    expect(pathMatchesViewer('/a/b/x.ts', null)).toBe(false);
  });
});

describe('findPendingWriteForFile', () => {
  const now = Date.now();

  it('finds a live Write/Edit targeting the open file', () => {
    expect(findPendingWriteForFile([editPrompt()], FILE, now)?.requestId).toBe('req-1');
  });

  it('ignores expired, resolved(answered), non-reviewable, or non-matching prompts', () => {
    expect(findPendingWriteForFile([editPrompt({ expiresAt: now - 1 })], FILE, now)).toBeNull();
    // resolved gate: markPromptAnswered / permission_resolved set `answered`.
    expect(findPendingWriteForFile([editPrompt({ answered: 'allow' })], FILE, now)).toBeNull();
    expect(findPendingWriteForFile([editPrompt({ tool: 'Bash' })], FILE, now)).toBeNull();
    expect(findPendingWriteForFile([editPrompt()], '/other/file.ts', now)).toBeNull();
    expect(findPendingWriteForFile([editPrompt()], null, now)).toBeNull();
  });
});

describe('ViewerPreWriteReview — wiring (source scan)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/ViewerPreWriteReview.tsx'),
    'utf-8',
  );

  it('exports ViewerPreWriteReview and the correlation helpers', () => {
    expect(source).toMatch(/export\s+function\s+ViewerPreWriteReview/);
    expect(source).toMatch(/export\s+function\s+pathMatchesViewer/);
    expect(source).toMatch(/export\s+function\s+findPendingWriteForFile/);
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

  it('marks the prompt answered locally on a successful send (resolved gate)', () => {
    expect(source).toContain("sent === 'sent'");
    expect(source).toContain('markPromptAnswered(messageId');
  });

  it('gates on features.ide (serverCapabilities.ide)', () => {
    expect(source).toContain('s.serverCapabilities?.ide');
    expect(source).toContain('if (!ideEnabled || !pending || !requestId) return null');
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
