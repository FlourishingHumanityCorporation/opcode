import { create } from 'zustand';

import type { EventEnvelopeV1, SnapshotV1 } from '../../../../packages/mobile-sync-protocol/src';

interface SyncState {
  snapshot: SnapshotV1 | null;
  events: EventEnvelopeV1[];
  lastSequence: number;
  connected: boolean;
  setConnected: (connected: boolean) => void;
  setSnapshot: (snapshot: SnapshotV1) => void;
  appendEvent: (event: EventEnvelopeV1) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  snapshot: null,
  events: [],
  lastSequence: 0,
  connected: false,
  setConnected: (connected) => set({ connected }),
  setSnapshot: (snapshot) =>
    set({
      snapshot,
      lastSequence: snapshot.sequence,
    }),
  appendEvent: (event) =>
    set((state) => ({
      events: [...state.events.slice(-99), event],
      lastSequence: Math.max(state.lastSequence, event.sequence),
    })),
}));
