import { create } from 'zustand';
import type { WebTask, WebFeatureStatus } from './types';

interface WebState {
  webFeatures: WebFeatureStatus;
  webTasks: WebTask[];

  setWebFeatures: (features: WebFeatureStatus) => void;
  upsertTask: (task: WebTask) => void;
  updateTaskError: (taskId: string, error: string) => void;
  setTasks: (tasks: WebTask[]) => void;
  reset: () => void;
}

const initialState = {
  webFeatures: { available: false, remote: false, teleport: false } as WebFeatureStatus,
  webTasks: [] as WebTask[],
};

export const useWebStore = create<WebState>((set) => ({
  ...initialState,

  setWebFeatures: (features) => set({ webFeatures: features }),

  upsertTask: (task) =>
    set((state) => ({
      webTasks: [...state.webTasks.filter((t) => t.taskId !== task.taskId), task],
    })),

  updateTaskError: (taskId, error) =>
    set((state) => ({
      webTasks: state.webTasks.map((t) =>
        t.taskId === taskId ? { ...t, status: 'failed' as const, error } : t,
      ),
    })),

  setTasks: (tasks) => set({ webTasks: tasks }),

  reset: () => set({ ...initialState }),
}));
