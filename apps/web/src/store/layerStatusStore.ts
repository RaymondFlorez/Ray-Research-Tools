import { create } from 'zustand';
import type { LoadStatus } from '../data/useResolvedData';

/** Per-layer data load status, published by GlobeCanvas and read by the Layer panel. */
interface LayerStatusStore {
  status: Record<string, LoadStatus>;
  setStatus: (status: Record<string, LoadStatus>) => void;
}

export const useLayerStatusStore = create<LayerStatusStore>((set) => ({
  status: {},
  setStatus: (status) => set({ status }),
}));
