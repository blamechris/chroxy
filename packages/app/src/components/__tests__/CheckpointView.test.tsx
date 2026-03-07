// @ts-nocheck — react-test-renderer lacks type declarations in this project
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, Text } from 'react-native';
import { CheckpointView } from '../CheckpointView';
import { useConnectionStore } from '../../store/connection';

// Mock the connection store
const mockListCheckpoints = jest.fn();
const mockRestoreCheckpoint = jest.fn();
const mockDeleteCheckpoint = jest.fn();
const mockCreateCheckpoint = jest.fn();

jest.mock('../../store/connection', () => ({
  useConnectionStore: jest.fn(),
}));

const mockUseConnectionStore = useConnectionStore as unknown as jest.Mock;

function setupStore(checkpoints: any[] = []) {
  mockUseConnectionStore.mockImplementation((selector: any) => {
    const state = {
      checkpoints,
      listCheckpoints: mockListCheckpoints,
      restoreCheckpoint: mockRestoreCheckpoint,
      deleteCheckpoint: mockDeleteCheckpoint,
      createCheckpoint: mockCreateCheckpoint,
    };
    return selector(state);
  });
}

const sampleCheckpoints = [
  {
    id: 'cp-1',
    name: 'Initial setup',
    description: 'After setting up the project',
    messageCount: 5,
    createdAt: Date.now() - 3600000,
    hasGitSnapshot: false,
  },
  {
    id: 'cp-2',
    name: 'Added auth',
    description: 'Authentication flow complete',
    messageCount: 15,
    createdAt: Date.now() - 1800000,
    hasGitSnapshot: true,
  },
  {
    id: 'cp-3',
    name: 'Refactored store',
    description: '',
    messageCount: 25,
    createdAt: Date.now() - 60000,
    hasGitSnapshot: false,
  },
];

/** Find all text nodes containing a substring */
function findTextNodes(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root.findAll(
    (node) =>
      node.type === Text &&
      typeof node.props.children === 'string' &&
      node.props.children.includes(text),
  );
}

/** Find a touchable by accessibilityLabel */
function findByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.findByProps({ accessibilityLabel: label });
}

describe('CheckpointView', () => {
  const onClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls listCheckpoints when visible', () => {
    setupStore([]);
    act(() => {
      renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });
    expect(mockListCheckpoints).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when no checkpoints', () => {
    setupStore([]);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });
    expect(findTextNodes(root!.root, 'No checkpoints yet').length).toBeGreaterThan(0);
  });

  it('renders checkpoint items', () => {
    setupStore(sampleCheckpoints);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });
    expect(findTextNodes(root!.root, 'Initial setup').length).toBeGreaterThan(0);
    expect(findTextNodes(root!.root, 'Added auth').length).toBeGreaterThan(0);
    expect(findTextNodes(root!.root, 'Refactored store').length).toBeGreaterThan(0);
  });

  it('shows message count per checkpoint', () => {
    setupStore(sampleCheckpoints);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });
    expect(findTextNodes(root!.root, '5 messages').length).toBeGreaterThan(0);
    expect(findTextNodes(root!.root, '15 messages').length).toBeGreaterThan(0);
    expect(findTextNodes(root!.root, '25 messages').length).toBeGreaterThan(0);
  });

  it('shows git snapshot badge for checkpoints with git state', () => {
    setupStore(sampleCheckpoints);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });
    // Only cp-2 has hasGitSnapshot: true
    const gitBadges = findTextNodes(root!.root, 'git snapshot');
    expect(gitBadges).toHaveLength(1);
  });

  it('shows restore confirmation alert on restore press', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    setupStore(sampleCheckpoints);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });

    // Tap restore on cp-1
    act(() => {
      findByLabel(root!.root, 'Restore checkpoint Initial setup').props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Restore Checkpoint',
      expect.stringContaining('Restore to "Initial setup"'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Restore' }),
      ]),
    );
  });

  it('calls restoreCheckpoint and closes on restore confirm', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    setupStore(sampleCheckpoints);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });

    // Tap restore on cp-2
    act(() => {
      findByLabel(root!.root, 'Restore checkpoint Added auth').props.onPress();
    });

    // Simulate pressing Restore in the Alert
    const restoreBtn = alertSpy.mock.calls[0][2]?.find(
      (b: any) => b.text === 'Restore',
    );
    restoreBtn?.onPress?.();

    expect(mockRestoreCheckpoint).toHaveBeenCalledWith('cp-2');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not restore on cancel', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    setupStore(sampleCheckpoints);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });

    act(() => {
      findByLabel(root!.root, 'Restore checkpoint Added auth').props.onPress();
    });

    // Cancel button has no onPress (Alert dismiss)
    const cancelBtn = alertSpy.mock.calls[0][2]?.find(
      (b: any) => b.text === 'Cancel',
    );
    // Cancel style just dismisses alert, no onPress
    expect(cancelBtn?.style).toBe('cancel');
    expect(mockRestoreCheckpoint).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows delete confirmation via Alert on delete press', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    setupStore(sampleCheckpoints);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });

    act(() => {
      findByLabel(root!.root, 'Delete checkpoint Initial setup').props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Delete Checkpoint',
      expect.stringContaining('Delete "Initial setup"'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Delete', style: 'destructive' }),
      ]),
    );

    // Simulate pressing Delete in the Alert
    const deleteButton = alertSpy.mock.calls[0][2]?.find(
      (b: any) => b.text === 'Delete',
    );
    deleteButton?.onPress?.();
    expect(mockDeleteCheckpoint).toHaveBeenCalledWith('cp-1');
  });

  it('close button calls onClose', () => {
    setupStore([]);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });

    act(() => {
      findByLabel(root!.root, 'Close checkpoints').props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows description when present', () => {
    setupStore(sampleCheckpoints);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });
    expect(findTextNodes(root!.root, 'After setting up the project').length).toBeGreaterThan(0);
    expect(findTextNodes(root!.root, 'Authentication flow complete').length).toBeGreaterThan(0);
  });

  it('has create checkpoint button', () => {
    setupStore([]);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });
    expect(findTextNodes(root!.root, 'Create Checkpoint').length).toBeGreaterThan(0);
  });

  it('create flow: tap Create, enter name, confirm calls createCheckpoint', () => {
    setupStore([]);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });

    // Tap "Create new checkpoint" to show input
    act(() => {
      findByLabel(root!.root, 'Create new checkpoint').props.onPress();
    });

    // Enter a name in the TextInput
    const input = root!.root.findByProps({ placeholder: 'Checkpoint name (optional)' });
    act(() => {
      input.props.onChangeText('My checkpoint');
    });

    // Tap confirm button
    act(() => {
      findByLabel(root!.root, 'Create checkpoint').props.onPress();
    });

    expect(mockCreateCheckpoint).toHaveBeenCalledWith('My checkpoint');
  });

  it('create flow with empty name passes undefined', () => {
    setupStore([]);
    let root: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<CheckpointView visible={true} onClose={onClose} />);
    });

    // Tap "Create new checkpoint" to show input
    act(() => {
      findByLabel(root!.root, 'Create new checkpoint').props.onPress();
    });

    // Confirm without entering a name
    act(() => {
      findByLabel(root!.root, 'Create checkpoint').props.onPress();
    });

    expect(mockCreateCheckpoint).toHaveBeenCalledWith(undefined);
  });
});
