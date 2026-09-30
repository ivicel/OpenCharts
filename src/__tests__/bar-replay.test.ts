import { beforeEach, describe, expect, it } from "vitest";
import {
  indexAtOrBefore,
  useBarReplayStore,
  visibleCandles,
} from "@/pages/trading/bar-replay/replayStore";
import type { Candle } from "@/services/schemas";

const START = 1_700_000_000;

function bars(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: START + i * 60,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1,
  }));
}

const store = () => useBarReplayStore.getState();

describe("replay timeline helpers", () => {
  const series = bars(5);

  it("finds the last bar at or before a time", () => {
    expect(indexAtOrBefore(series, START)).toBe(0);
    expect(indexAtOrBefore(series, START + 60)).toBe(1);
    // Between bars snaps back to the older one.
    expect(indexAtOrBefore(series, START + 90)).toBe(1);
    expect(indexAtOrBefore(series, START + 10_000)).toBe(4);
  });

  it("reports -1 when the time predates the snapshot", () => {
    expect(indexAtOrBefore(series, START - 1)).toBe(-1);
    expect(indexAtOrBefore([], START)).toBe(-1);
  });

  it("shows everything until a start point is picked, then only up to the cursor", () => {
    // Picking: the chart must stay visible, otherwise there is nothing to click.
    expect(visibleCandles(series, -1)).toHaveLength(5);
    expect(visibleCandles([], 3)).toEqual([]);
    expect(visibleCandles(series, 0)).toHaveLength(1);
    expect(visibleCandles(series, 2).map((b) => b.time)).toEqual([
      START,
      START + 60,
      START + 120,
    ]);
    // A cursor past the end never over-slices.
    expect(visibleCandles(series, 99)).toHaveLength(5);
  });
});

describe("bar replay state machine", () => {
  beforeEach(() => {
    store().exit();
  });

  it("starts by asking for a starting bar", () => {
    store().begin("BTCUSD", "15m");
    expect(store().status).toBe("picking");
    expect(store().symbol).toBe("BTCUSD");
    expect(store().timeframe).toBe("15m");
    expect(store().bars).toEqual([]);
    expect(store().snapshotLoaded).toBe(false);
  });

  it("hides everything after the clicked bar", () => {
    store().begin("BTCUSD", "1m");
    store().setSnapshot(bars(10));
    store().pickStartAt(START + 300);
    expect(store().status).toBe("ready");
    expect(store().cursorIndex).toBe(5);
    expect(visibleCandles(store().bars, store().cursorIndex)).toHaveLength(6);
  });

  it("ignores a pick that predates the snapshot", () => {
    store().begin("BTCUSD", "1m");
    store().setSnapshot(bars(10));
    store().pickStartAt(START - 1);
    expect(store().cursorIndex).toBe(-1);
    expect(store().status).toBe("picking");
  });

  it("remembers a click that lands before the snapshot arrives", () => {
    store().begin("BTCUSD", "1m");
    // The snapshot for a deep timeframe takes seconds; the click must survive.
    store().pickStartAt(START + 300);
    expect(store().cursorIndex).toBe(-1);
    expect(store().pendingPickTime).toBe(START + 300);

    store().setSnapshot(bars(10));
    expect(store().status).toBe("ready");
    expect(store().cursorIndex).toBe(5);
    expect(store().pendingPickTime).toBeNull();
  });

  it("steps one bar at a time and clamps at both ends", () => {
    store().begin("BTCUSD", "1m");
    store().setSnapshot(bars(4));
    store().pickStartAt(START);
    store().stepBy(2);
    expect(store().cursorIndex).toBe(2);
    store().stepBy(-5);
    expect(store().cursorIndex).toBe(0);
    store().stepBy(99);
    expect(store().cursorIndex).toBe(3);
  });

  it("cannot step before a start point has been chosen", () => {
    store().begin("BTCUSD", "1m");
    store().setSnapshot(bars(4));
    store().stepBy(1);
    expect(store().cursorIndex).toBe(-1);
    expect(store().status).toBe("picking");
  });

  it("stops playing when the snapshot runs out", () => {
    store().begin("BTCUSD", "1m");
    store().setSnapshot(bars(3));
    store().pickStartAt(START);
    store().play();
    expect(store().status).toBe("playing");
    store().stepBy(1);
    expect(store().status).toBe("playing");
    store().stepBy(1);
    expect(store().cursorIndex).toBe(2);
    expect(store().status).toBe("paused");
  });

  it("rewinds off the last bar when play is pressed at the end", () => {
    store().begin("BTCUSD", "1m");
    store().setSnapshot(bars(3));
    store().pickStartAt(START + 120);
    expect(store().cursorIndex).toBe(2);
    store().play();
    expect(store().status).toBe("playing");
    expect(store().cursorIndex).toBe(1);
  });

  it("keeps the snapshot when re-picking the start", () => {
    store().begin("BTCUSD", "1m");
    store().setSnapshot(bars(5));
    store().pickStartAt(START + 180);
    store().resetStart();
    expect(store().status).toBe("picking");
    expect(store().cursorIndex).toBe(-1);
    expect(store().bars).toHaveLength(5);
  });

  it("remembers the speed but clears the session on exit", () => {
    store().begin("BTCUSD", "1m");
    store().setSnapshot(bars(5));
    store().pickStartAt(START);
    store().setSpeed(10);
    store().setFollow(false);
    store().exit();

    expect(store().status).toBe("off");
    expect(store().bars).toEqual([]);
    expect(store().cursorIndex).toBe(-1);
    expect(store().follow).toBe(true);
    // Speed is a preference, not session state.
    expect(store().speed).toBe(10);

    store().begin("BTCUSD", "1m");
    expect(store().speed).toBe(10);
  });
});
