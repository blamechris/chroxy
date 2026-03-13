import { useCostStore } from '../../store/cost';

describe('CostStore', () => {
  beforeEach(() => {
    useCostStore.getState().reset();
  });

  it('initializes with null values', () => {
    const state = useCostStore.getState();
    expect(state.totalCost).toBeNull();
    expect(state.costBudget).toBeNull();
  });

  it('sets totalCost', () => {
    useCostStore.getState().setTotalCost(1.2345);
    expect(useCostStore.getState().totalCost).toBe(1.2345);
  });

  it('sets costBudget', () => {
    useCostStore.getState().setCostBudget(10.0);
    expect(useCostStore.getState().costBudget).toBe(10.0);
  });

  it('sets both cost and budget together', () => {
    useCostStore.getState().setCostUpdate(5.5, 20.0);
    const state = useCostStore.getState();
    expect(state.totalCost).toBe(5.5);
    expect(state.costBudget).toBe(20.0);
  });

  it('handles null totalCost in setCostUpdate', () => {
    useCostStore.getState().setTotalCost(1.0);
    useCostStore.getState().setCostUpdate(null, 10.0);
    const state = useCostStore.getState();
    expect(state.totalCost).toBeNull();
    expect(state.costBudget).toBe(10.0);
  });

  it('handles null costBudget in setCostUpdate', () => {
    useCostStore.getState().setCostBudget(10.0);
    useCostStore.getState().setCostUpdate(2.0, null);
    const state = useCostStore.getState();
    expect(state.totalCost).toBe(2.0);
    expect(state.costBudget).toBeNull();
  });

  it('resets to initial state', () => {
    useCostStore.getState().setTotalCost(5.0);
    useCostStore.getState().setCostBudget(20.0);
    useCostStore.getState().reset();
    const state = useCostStore.getState();
    expect(state.totalCost).toBeNull();
    expect(state.costBudget).toBeNull();
  });
});
