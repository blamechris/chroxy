import { useWebStore } from '../../store/web';

describe('WebStore', () => {
  beforeEach(() => {
    useWebStore.getState().reset();
  });

  it('initializes with defaults', () => {
    const state = useWebStore.getState();
    expect(state.webFeatures).toEqual({ available: false, remote: false, teleport: false });
    expect(state.webTasks).toEqual([]);
  });

  it('setWebFeatures updates feature flags', () => {
    useWebStore.getState().setWebFeatures({ available: true, remote: true, teleport: false });
    expect(useWebStore.getState().webFeatures).toEqual({ available: true, remote: true, teleport: false });
  });

  it('upsertTask adds a new task', () => {
    const task = {
      taskId: 't1',
      prompt: 'build a website',
      status: 'pending' as const,
      createdAt: 1000,
      updatedAt: 1000,
      result: null,
      error: null,
    };
    useWebStore.getState().upsertTask(task);
    expect(useWebStore.getState().webTasks).toEqual([task]);
  });

  it('upsertTask replaces existing task with same ID', () => {
    const task1 = {
      taskId: 't1',
      prompt: 'build a website',
      status: 'pending' as const,
      createdAt: 1000,
      updatedAt: 1000,
      result: null,
      error: null,
    };
    useWebStore.getState().upsertTask(task1);
    useWebStore.getState().upsertTask({ ...task1, status: 'running' as const, updatedAt: 2000 });
    const tasks = useWebStore.getState().webTasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('running');
  });

  it('updateTaskError sets error on matching task', () => {
    useWebStore.getState().upsertTask({
      taskId: 't1',
      prompt: 'test',
      status: 'running' as const,
      createdAt: 1000,
      updatedAt: 1000,
      result: null,
      error: null,
    });
    useWebStore.getState().updateTaskError('t1', 'something failed');
    const updated = useWebStore.getState().webTasks[0];
    expect(updated.status).toBe('failed');
    expect(updated.error).toBe('something failed');
    expect(updated.updatedAt).toBeGreaterThan(1000);
  });

  it('updateTaskError does not crash on unknown task', () => {
    useWebStore.getState().updateTaskError('nonexistent', 'error');
    expect(useWebStore.getState().webTasks).toEqual([]);
  });

  it('setTasks bulk-replaces all tasks', () => {
    const tasks = [
      { taskId: 't1', prompt: 'a', status: 'completed' as const, createdAt: 1, updatedAt: 1, result: 'done', error: null },
      { taskId: 't2', prompt: 'b', status: 'pending' as const, createdAt: 2, updatedAt: 2, result: null, error: null },
    ];
    useWebStore.getState().setTasks(tasks);
    expect(useWebStore.getState().webTasks).toEqual(tasks);
  });

  it('reset clears all state', () => {
    useWebStore.getState().setWebFeatures({ available: true, remote: true, teleport: true });
    useWebStore.getState().upsertTask({
      taskId: 't1', prompt: 'test', status: 'running' as const,
      createdAt: 1, updatedAt: 1, result: null, error: null,
    });
    useWebStore.getState().reset();
    expect(useWebStore.getState().webFeatures).toEqual({ available: false, remote: false, teleport: false });
    expect(useWebStore.getState().webTasks).toEqual([]);
  });
});
