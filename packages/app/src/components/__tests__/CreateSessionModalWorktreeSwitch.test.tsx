import React from 'react';
import { act } from 'react';
import renderer from 'react-test-renderer';
import { CreateSessionModal } from '../CreateSessionModal';
import { useConnectionStore } from '../../store/connection';

jest.mock('../../store/connection', () => ({
  useConnectionStore: jest.fn(),
}));

jest.mock('../FolderBrowser', () => ({
  FolderBrowser: () => null,
}));

const mockUseConnectionStore = useConnectionStore as unknown as jest.Mock;
const mockCreateSession = jest.fn();
// Must be referentially stable: the modal's open-effect depends on it and
// resets the worktree flag whenever it changes.
const mockFetchProviders = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

// #8214: the worktree switch is disabled while the working directory is empty.
// It must say why (visible text + VoiceOver hint) and must never submit a stale
// `worktree: true` after the directory is cleared.
describe('CreateSessionModal — #8214 worktree switch explains why it is disabled', () => {
  const REASON = 'Choose a working directory first — worktree isolation needs a git repo';

  function mount() {
    mockUseConnectionStore.mockImplementation((selector: any) =>
      selector({
        availableProviders: [],
        fetchProviders: mockFetchProviders,
        createSession: mockCreateSession,
        sessions: [],
      }),
    );
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(<CreateSessionModal visible onClose={jest.fn()} />);
    });
    return component!;
  }
  const setCwd = (c: renderer.ReactTestRenderer, v: string) =>
    act(() => {
      c.root.findByProps({ testID: 'cwd-input' }).props.onChangeText(v);
    });
  const hintText = (c: renderer.ReactTestRenderer) =>
    c.root.findByProps({ testID: 'worktree-switch-hint' }).props.children;
  const sw = (c: renderer.ReactTestRenderer) => c.root.findByProps({ testID: 'worktree-switch' });

  it('shows the reason, disabled state and a11y props when the working directory is empty', () => {
    const c = mount();
    expect(hintText(c)).toBe(REASON);
    expect(sw(c).props.disabled).toBe(true);
    expect(sw(c).props.accessibilityState).toEqual({ disabled: true, checked: false });
    expect(sw(c).props.accessibilityHint).toContain(REASON);
  });

  it('shows no reason and an enabled switch once a working directory is entered', () => {
    const c = mount();
    setCwd(c, '/repo');
    expect(hintText(c)).not.toContain('Choose a working directory');
    expect(sw(c).props.disabled).toBe(false);
    expect(sw(c).props.accessibilityState).toEqual({ disabled: false, checked: false });
    expect(sw(c).props.accessibilityHint).not.toContain(REASON);
  });

  it('does not submit a stale worktree flag after the directory is cleared', () => {
    const c = mount();
    setCwd(c, '/repo');
    act(() => {
      sw(c).props.onValueChange(true);
    });
    setCwd(c, '');
    act(() => {
      c.root.findByProps({ accessibilityLabel: 'Create session' }).props.onPress();
    });
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession.mock.calls[0][0].worktree).toBeUndefined();
  });
});
