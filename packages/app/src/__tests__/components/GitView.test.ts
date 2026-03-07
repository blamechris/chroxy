/**
 * Source-scan tests for GitView component.
 *
 * Validates that the component uses the correct store methods,
 * handles all git result types, and cleans up callbacks.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '../../components/GitView.tsx'),
  'utf-8',
);

describe('GitView source scan', () => {
  // Store integration
  it('imports from the connection store', () => {
    expect(SRC).toContain("from '../store/connection'");
  });

  it('uses setGitStatusCallback for cleanup', () => {
    expect(SRC).toContain('setGitStatusCallback');
  });

  it('uses setGitBranchesCallback for cleanup', () => {
    expect(SRC).toContain('setGitBranchesCallback');
  });

  it('uses setGitStageCallback for stage operations', () => {
    expect(SRC).toContain('setGitStageCallback');
  });

  it('uses setGitCommitCallback for commit operations', () => {
    expect(SRC).toContain('setGitCommitCallback');
  });

  it('calls requestGitStatus to fetch status', () => {
    expect(SRC).toContain('requestGitStatus');
  });

  it('calls requestGitBranches to fetch branches', () => {
    expect(SRC).toContain('requestGitBranches');
  });

  it('calls requestGitStage to stage files', () => {
    expect(SRC).toContain('requestGitStage');
  });

  it('calls requestGitUnstage to unstage files', () => {
    expect(SRC).toContain('requestGitUnstage');
  });

  it('calls requestGitCommit to commit', () => {
    expect(SRC).toContain('requestGitCommit');
  });

  // UI structure
  it('renders changes and branches tabs', () => {
    expect(SRC).toContain("'changes'");
    expect(SRC).toContain("'branches'");
  });

  it('uses Modal for overlay presentation', () => {
    expect(SRC).toContain('<Modal');
  });

  it('has a commit text input', () => {
    expect(SRC).toContain('<TextInput');
    expect(SRC).toContain('commitMessage');
  });

  // Accessibility
  it('includes accessibility labels', () => {
    expect(SRC).toContain('accessibilityRole');
    expect(SRC).toContain('accessibilityLabel');
  });

  it('uses accessibilityState for checkboxes', () => {
    expect(SRC).toContain('accessibilityState');
  });

  // Type safety
  it('imports git types from store/types', () => {
    expect(SRC).toContain('GitFileStatus');
    expect(SRC).toContain('GitStatusResult');
    expect(SRC).toContain('GitBranchesResult');
    expect(SRC).toContain('GitStageResult');
    expect(SRC).toContain('GitCommitResult');
  });
});
