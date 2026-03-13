import { create } from 'zustand';

interface CostState {
  totalCost: number | null;
  costBudget: number | null;

  setTotalCost: (cost: number | null) => void;
  setCostBudget: (budget: number | null) => void;
  setCostUpdate: (totalCost: number | null, budget: number | null) => void;
  reset: () => void;
}

const initialState = {
  totalCost: null as number | null,
  costBudget: null as number | null,
};

export const useCostStore = create<CostState>((set) => ({
  ...initialState,

  setTotalCost: (cost) => set({ totalCost: cost }),
  setCostBudget: (budget) => set({ costBudget: budget }),
  setCostUpdate: (totalCost, budget) => set({ totalCost, costBudget: budget }),
  reset: () => set(initialState),
}));
