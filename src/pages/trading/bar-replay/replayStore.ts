import { create } from "zustand";
import type { Candle } from "../../../services/schemas.ts";
import type { Timeframe } from "../constants.ts";

/**
 * Client-side Bar Replay engine (TradingView-style).
 *
 * The session owns a *frozen* snapshot of history for one symbol/timeframe and
 * a cursor into it. Everything after the cursor stays hidden — the chart simply
 * renders `visibleCandles(bars, cursorIndex)` — which is why replay never
 * touches the live query cache and cannot be painted over by real-time data.
 *
 * This store is deliberately pure: fetching lives in the loader hook so the
 * state machine can be unit-tested without the network or the demo layer.
 */

export type BarReplayStatus =
  /** Not replaying. */
  | "off"
  /** Waiting for the user to click a starting bar (snapshot may still be loading). */
  | "picking"
  /** Start point chosen, paused at it. */
  | "ready"
  | "playing"
  | "paused";

/** Playback ladder. `Infinity` is TradingView's "Max". */
export const REPLAY_SPEEDS = [0.5, 1, 2, 3, 5, 10, Number.POSITIVE_INFINITY] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export function formatReplaySpeed(speed: number): string {
  return Number.isFinite(speed) ? `${speed}x` : "Max";
}

/**
 * Index of the last bar at or before `timeSec` (binary search), or -1 when the
 * time predates the snapshot.
 */
export function indexAtOrBefore(bars: Candle[], timeSec: number): number {
  let low = 0;
  let high = bars.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (bars[mid]!.time <= timeSec) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Bars to render.
 *
 * Before a starting bar is chosen (cursor -1) the whole snapshot is shown: the
 * user has to see the chart in order to click it, and nothing is "future" yet.
 * Once a start point exists, everything after it stays hidden.
 */
export function visibleCandles(bars: Candle[], cursorIndex: number): Candle[] {
  if (bars.length === 0) return [];
  if (cursorIndex < 0) return bars;
  return bars.slice(0, Math.min(cursorIndex + 1, bars.length));
}

interface BarReplayStore {
  status: BarReplayStatus;
  symbol: string | null;
  timeframe: Timeframe | null;
  /** Frozen history snapshot for the session. */
  bars: Candle[];
  /** The snapshot request has settled (successfully or not). */
  snapshotLoaded: boolean;
  error: string | null;
  /** Index of the newest revealed bar. */
  cursorIndex: number;
  /**
   * A starting bar clicked before the snapshot finished loading. The snapshot
   * can take seconds on a deep timeframe; dropping the click would leave the
   * user clicking again at a chart that looks broken.
   */
  pendingPickTime: number | null;
  speed: ReplaySpeed;
  /** Auto-scroll the viewport so the cursor stays at the right edge. */
  follow: boolean;

  begin: (symbol: string, timeframe: Timeframe) => void;
  setSnapshot: (bars: Candle[]) => void;
  setError: (message: string) => void;
  pickStartAt: (timeSec: number) => void;
  /** Back to "pick a starting bar", keeping the snapshot. */
  resetStart: () => void;
  stepBy: (delta: number) => void;
  setCursorIndex: (index: number) => void;
  play: () => void;
  pause: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
  setFollow: (follow: boolean) => void;
  exit: () => void;
}

const IDLE = {
  status: "off" as BarReplayStatus,
  symbol: null,
  timeframe: null,
  bars: [] as Candle[],
  snapshotLoaded: false,
  error: null,
  cursorIndex: -1,
  pendingPickTime: null as number | null,
  speed: 1 as ReplaySpeed,
  follow: true,
};

export const useBarReplayStore = create<BarReplayStore>((set, get) => ({
  ...IDLE,

  begin: (symbol, timeframe) =>
    set({
      ...IDLE,
      status: "picking",
      symbol,
      timeframe,
      // Preserve the user's last speed choice across sessions.
      speed: get().speed,
    }),

  setSnapshot: (bars) => {
    // A click that arrived while the snapshot was loading is honoured now.
    const pending = get().pendingPickTime;
    const index = pending != null ? indexAtOrBefore(bars, pending) : -1;
    set({
      bars,
      snapshotLoaded: true,
      error: null,
      pendingPickTime: null,
      ...(index >= 0 ? { cursorIndex: index, status: "ready" as const } : {}),
    });
  },

  setError: (message) => set({ error: message, snapshotLoaded: true, pendingPickTime: null }),

  pickStartAt: (timeSec) => {
    const { bars, status } = get();
    if (status !== "picking" && status !== "ready" && status !== "paused") return;
    if (bars.length === 0) {
      // Snapshot still loading — remember the click instead of dropping it.
      set({ pendingPickTime: timeSec });
      return;
    }
    const index = indexAtOrBefore(bars, timeSec);
    if (index < 0) return;
    set({ cursorIndex: index, status: "ready" });
  },

  resetStart: () => {
    const { status, bars } = get();
    if (status === "off") return;
    set({
      status: "picking",
      cursorIndex: -1,
      pendingPickTime: null,
      // "Start point" doubles as a retry when the snapshot never arrived.
      ...(bars.length === 0 ? { snapshotLoaded: false, error: null } : {}),
    });
  },

  stepBy: (delta) => {
    const { bars, cursorIndex, status } = get();
    if (bars.length === 0 || status === "off" || status === "picking") return;
    const next = Math.max(0, Math.min(cursorIndex + delta, bars.length - 1));
    if (next === cursorIndex) {
      // Reaching the end stops playback rather than looping.
      if (status === "playing" && delta > 0) set({ status: "paused" });
      return;
    }
    const reachedEnd = next >= bars.length - 1;
    set({
      cursorIndex: next,
      status: status === "playing" && reachedEnd && delta > 0 ? "paused" : status,
    });
  },

  setCursorIndex: (index) => {
    const { bars } = get();
    if (bars.length === 0) return;
    set({ cursorIndex: Math.max(0, Math.min(index, bars.length - 1)) });
  },

  play: () => {
    const { status, bars, cursorIndex } = get();
    if (status === "off" || status === "picking" || bars.length === 0) return;
    // Playing from the very end would stop immediately; rewind one bar first,
    // mirroring TradingView's "play restarts the last bar" behaviour.
    const atEnd = cursorIndex >= bars.length - 1;
    set({ status: "playing", cursorIndex: atEnd ? Math.max(0, bars.length - 2) : cursorIndex });
  },

  pause: () => {
    if (get().status === "playing") set({ status: "paused" });
  },

  setSpeed: (speed) => set({ speed }),

  setFollow: (follow) => set({ follow }),

  exit: () => set({ ...IDLE, speed: get().speed }),
}));
