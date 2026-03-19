/**
 * MRU (Most Recently Used) command store — Zustand-based.
 *
 * Persists to localStorage so MRU order survives page reloads.
 * Replaces the previous plain-function approach from commands.ts.
 */
import { create } from 'zustand'

const MRU_KEY = 'chroxy-mru-commands'
const MRU_MAX = 10

function loadMru(): string[] {
  try {
    const raw = localStorage.getItem(MRU_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, MRU_MAX)
  } catch {
    return []
  }
}

function saveMru(mru: string[]): void {
  try {
    localStorage.setItem(MRU_KEY, JSON.stringify(mru))
  } catch {
    // Storage not available
  }
}

interface MruState {
  mruList: string[]
  recordCommand: (id: string) => void
}

export const useMruStore = create<MruState>((set, get) => ({
  mruList: loadMru(),

  recordCommand: (id: string) => {
    const current = get().mruList.filter(x => x !== id)
    current.unshift(id)
    const trimmed = current.slice(0, MRU_MAX)
    saveMru(trimmed)
    set({ mruList: trimmed })
  },

}))
