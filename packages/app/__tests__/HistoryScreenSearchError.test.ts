/**
 * Tests for search error state in HistoryScreen.
 * Verifies that the store tracks searchError and that search timeout/disconnect
 * surfaces an error message instead of silently clearing the loading state.
 */
import { useConnectionStore } from '../src/store/connection';

beforeEach(() => {
  useConnectionStore.setState({
    searchResults: [],
    searchLoading: false,
    searchQuery: '',
    searchError: null,
  });
});

describe('searchConversations error handling', () => {
  it('sets searchError when not connected', () => {
    // No socket — should set error immediately
    useConnectionStore.getState().searchConversations('test query');

    const state = useConnectionStore.getState();
    expect(state.searchError).toBe('Not connected to server.');
  });

  it('clears searchError on new search', () => {
    jest.useFakeTimers();
    useConnectionStore.setState({ searchError: 'previous error' });

    // Create a mock socket
    const mockSocket = { readyState: 1, send: jest.fn() } as any;
    useConnectionStore.setState({ socket: mockSocket });

    useConnectionStore.getState().searchConversations('new query');

    const state = useConnectionStore.getState();
    expect(state.searchError).toBeNull();
    expect(state.searchLoading).toBe(true);

    jest.useRealTimers();
  });

  it('clears searchError on clearSearchResults', () => {
    useConnectionStore.setState({ searchError: 'some error' });

    useConnectionStore.getState().clearSearchResults();

    const state = useConnectionStore.getState();
    expect(state.searchError).toBeNull();
    expect(state.searchQuery).toBe('');
  });

  it('sets searchError on timeout', () => {
    jest.useFakeTimers();

    const mockSocket = { readyState: 1, send: jest.fn() } as any;
    useConnectionStore.setState({ socket: mockSocket });

    useConnectionStore.getState().searchConversations('timeout query');
    expect(useConnectionStore.getState().searchLoading).toBe(true);

    // Advance past the 15s timeout
    jest.advanceTimersByTime(15000);

    const state = useConnectionStore.getState();
    expect(state.searchLoading).toBe(false);
    expect(state.searchError).toBe('Search timed out. Check your connection and try again.');

    jest.useRealTimers();
  });

  it('initializes searchError as null', () => {
    expect(useConnectionStore.getState().searchError).toBeNull();
  });
});
