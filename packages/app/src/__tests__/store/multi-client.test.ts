import { useMultiClientStore } from '../../store/multi-client';

describe('MultiClientStore', () => {
  beforeEach(() => {
    useMultiClientStore.getState().reset();
  });

  it('initializes with null/empty defaults', () => {
    const state = useMultiClientStore.getState();
    expect(state.myClientId).toBeNull();
    expect(state.connectedClients).toEqual([]);
    expect(state.primaryClientId).toBeNull();
    expect(state.followMode).toBe(false);
  });

  it('setMyClientId sets the client ID', () => {
    useMultiClientStore.getState().setMyClientId('client-123');
    expect(useMultiClientStore.getState().myClientId).toBe('client-123');
  });

  it('addClient adds a new connected client', () => {
    const client = {
      clientId: 'c1',
      deviceName: 'iPhone',
      deviceType: 'phone' as const,
      platform: 'ios',
      isSelf: false,
    };
    useMultiClientStore.getState().addClient(client);
    expect(useMultiClientStore.getState().connectedClients).toEqual([client]);
  });

  it('addClient replaces existing client with same ID', () => {
    const client1 = {
      clientId: 'c1',
      deviceName: 'iPhone',
      deviceType: 'phone' as const,
      platform: 'ios',
      isSelf: false,
    };
    const client2 = {
      clientId: 'c1',
      deviceName: 'iPad',
      deviceType: 'tablet' as const,
      platform: 'ios',
      isSelf: false,
    };
    useMultiClientStore.getState().addClient(client1);
    useMultiClientStore.getState().addClient(client2);
    const clients = useMultiClientStore.getState().connectedClients;
    expect(clients).toHaveLength(1);
    expect(clients[0].deviceName).toBe('iPad');
  });

  it('removeClient removes by clientId', () => {
    const client = {
      clientId: 'c1',
      deviceName: 'iPhone',
      deviceType: 'phone' as const,
      platform: 'ios',
      isSelf: false,
    };
    useMultiClientStore.getState().addClient(client);
    useMultiClientStore.getState().removeClient('c1');
    expect(useMultiClientStore.getState().connectedClients).toEqual([]);
  });

  it('removeClient returns the removed client', () => {
    const client = {
      clientId: 'c1',
      deviceName: 'iPhone',
      deviceType: 'phone' as const,
      platform: 'ios',
      isSelf: false,
    };
    useMultiClientStore.getState().addClient(client);
    const removed = useMultiClientStore.getState().removeClient('c1');
    expect(removed).toEqual(client);
  });

  it('removeClient returns undefined for unknown client', () => {
    const removed = useMultiClientStore.getState().removeClient('nonexistent');
    expect(removed).toBeUndefined();
  });

  it('setPrimaryClientId updates primary', () => {
    useMultiClientStore.getState().setPrimaryClientId('c1');
    expect(useMultiClientStore.getState().primaryClientId).toBe('c1');
  });

  it('setFollowMode toggles follow mode', () => {
    useMultiClientStore.getState().setFollowMode(true);
    expect(useMultiClientStore.getState().followMode).toBe(true);
    useMultiClientStore.getState().setFollowMode(false);
    expect(useMultiClientStore.getState().followMode).toBe(false);
  });

  it('setConnectedClients bulk-sets all clients', () => {
    const clients = [
      { clientId: 'c1', deviceName: 'iPhone', deviceType: 'phone' as const, platform: 'ios', isSelf: true },
      { clientId: 'c2', deviceName: 'Mac', deviceType: 'desktop' as const, platform: 'darwin', isSelf: false },
    ];
    useMultiClientStore.getState().setConnectedClients(clients);
    expect(useMultiClientStore.getState().connectedClients).toEqual(clients);
  });

  it('reset clears all state', () => {
    useMultiClientStore.getState().setMyClientId('c1');
    useMultiClientStore.getState().setFollowMode(true);
    useMultiClientStore.getState().addClient({
      clientId: 'c1',
      deviceName: 'Test',
      deviceType: 'phone',
      platform: 'ios',
      isSelf: true,
    });
    useMultiClientStore.getState().reset();
    const state = useMultiClientStore.getState();
    expect(state.myClientId).toBeNull();
    expect(state.connectedClients).toEqual([]);
    expect(state.primaryClientId).toBeNull();
    expect(state.followMode).toBe(false);
  });
});
