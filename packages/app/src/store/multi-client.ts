import { create } from 'zustand';
import type { ConnectedClient } from './types';

interface MultiClientState {
  myClientId: string | null;
  connectedClients: ConnectedClient[];
  primaryClientId: string | null;
  followMode: boolean;

  setMyClientId: (id: string | null) => void;
  setConnectedClients: (clients: ConnectedClient[]) => void;
  addClient: (client: ConnectedClient) => void;
  removeClient: (clientId: string) => ConnectedClient | undefined;
  setPrimaryClientId: (id: string | null) => void;
  setFollowMode: (enabled: boolean) => void;
  reset: () => void;
}

const initialState = {
  myClientId: null as string | null,
  connectedClients: [] as ConnectedClient[],
  primaryClientId: null as string | null,
  followMode: false,
};

export const useMultiClientStore = create<MultiClientState>((set, get) => ({
  ...initialState,

  setMyClientId: (id) => set({ myClientId: id }),

  setConnectedClients: (clients) => set({ connectedClients: clients }),

  addClient: (client) =>
    set((state) => ({
      connectedClients: [
        ...state.connectedClients.filter((c) => c.clientId !== client.clientId),
        client,
      ],
    })),

  removeClient: (clientId) => {
    const found = get().connectedClients.find((c) => c.clientId === clientId);
    set((state) => ({
      connectedClients: state.connectedClients.filter((c) => c.clientId !== clientId),
    }));
    return found;
  },

  setPrimaryClientId: (id) => set({ primaryClientId: id }),

  setFollowMode: (enabled) => set({ followMode: enabled }),

  reset: () => set({ ...initialState }),
}));
