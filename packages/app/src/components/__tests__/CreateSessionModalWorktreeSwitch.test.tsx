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
    // the switch shows what will be sent: off once the directory is gone
    expect(sw(c).props.value).toBe(false);
    act(() => {
      c.root.findByProps({ accessibilityLabel: 'Create session' }).props.onPress();
    });
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession.mock.calls[0][0].worktree).toBeUndefined();
  });
});

// #8972: a directory that is not a git repo must be refused up front, with the
// reason as visible text and in the VoiceOver hint, instead of failing after
// Create. Only a reply that echoes the latest request id and belongs to the
// current directory may disable the switch; `null` ("cannot tell") must not.
describe('CreateSessionModal — #8972 worktree switch refuses a non-git directory', () => {
  const NOT_GIT = 'This directory is not a git repository — worktree isolation needs a git repo';
  let requests: Array<{ path: string; requestId: string }>;
  let reply: ((r: { path: string | null; isGitRepo: boolean | null; requestId: string | null }) => void) | null;

  function mount() {
    requests = [];
    reply = null;
    mockUseConnectionStore.mockImplementation((selector: any) =>
      selector({
        availableProviders: [],
        fetchProviders: mockFetchProviders,
        createSession: mockCreateSession,
        sessions: [],
        requestGitRepoCheck: (path: string, requestId: string) => requests.push({ path, requestId }),
        setGitRepoCheckCallback: (cb: any) => {
          reply = cb;
        },
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
  const settle = () =>
    act(() => {
      jest.advanceTimersByTime(400);
    });
  const answer = (isGitRepo: boolean | null, over: Record<string, unknown> = {}) => {
    const last = requests[requests.length - 1];
    act(() => {
      reply!({ path: last.path, isGitRepo, requestId: last.requestId, ...over });
    });
  };
  const hintText = (c: renderer.ReactTestRenderer) =>
    c.root.findByProps({ testID: 'worktree-switch-hint' }).props.children;
  const sw = (c: renderer.ReactTestRenderer) => c.root.findByProps({ testID: 'worktree-switch' });

  it('disables the switch and shows the reason (text + VoiceOver hint) for a non-git directory', () => {
    const c = mount();
    setCwd(c, '/tmp/plain');
    expect(sw(c).props.disabled).toBe(false); // nothing known yet
    settle();
    expect(requests).toEqual([{ path: '/tmp/plain', requestId: expect.any(String) }]);
    answer(false);
    expect(sw(c).props.disabled).toBe(true);
    expect(hintText(c)).toBe(NOT_GIT);
    expect(sw(c).props.accessibilityState).toEqual({ disabled: true, checked: false });
    expect(sw(c).props.accessibilityHint).toContain(NOT_GIT);
  });

  it('keeps the switch enabled for a git directory and when the server cannot tell', () => {
    const c = mount();
    setCwd(c, '/repo');
    settle();
    answer(true);
    expect(sw(c).props.disabled).toBe(false);
    setCwd(c, '/elsewhere');
    settle();
    answer(null);
    expect(sw(c).props.disabled).toBe(false);
  });

  it('ignores a reply for a superseded request and re-enables on a new path', () => {
    const c = mount();
    setCwd(c, '/tmp/plain');
    settle();
    const stale = requests[0];
    setCwd(c, '/tmp/plain2');
    settle();
    act(() => {
      reply!({ path: stale.path, isGitRepo: false, requestId: stale.requestId });
    });
    expect(sw(c).props.disabled).toBe(false);
    answer(false);
    expect(sw(c).props.disabled).toBe(true);
    setCwd(c, '/repo');
    expect(sw(c).props.disabled).toBe(false);
  });

  it('does not submit worktree:true for a non-git directory ticked before the answer arrived', () => {
    const c = mount();
    setCwd(c, '/tmp/plain');
    act(() => {
      sw(c).props.onValueChange(true);
    });
    settle();
    answer(false);
    expect(sw(c).props.value).toBe(false);
    act(() => {
      c.root.findByProps({ accessibilityLabel: 'Create session' }).props.onPress();
    });
    expect(mockCreateSession.mock.calls[0][0].worktree).toBeUndefined();
  });
});
