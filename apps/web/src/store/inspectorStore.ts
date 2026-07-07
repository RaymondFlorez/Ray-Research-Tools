import { create } from 'zustand';
import type { PickResult } from '../globe/types';

/**
 * Ephemeral UI state for the Inspector. Scene State keeps only the canonical selection
 * (layerId + feature ids, per §5); the actual picked *properties* are transient view
 * state and live here, not in the serializable scene.
 */
export interface InspectorStore {
  picked: PickResult | null;
  setPicked: (pick: PickResult | null) => void;
}

export const useInspectorStore = create<InspectorStore>((set) => ({
  picked: null,
  setPicked: (picked) => set({ picked }),
}));
