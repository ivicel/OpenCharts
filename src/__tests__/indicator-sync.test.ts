import { describe, expect, it } from "vitest";
import type { CandlestickData, Time } from "lightweight-charts";
import { ema, rsi, sma, vwap } from "@/lib/indicators";
import { incrementalUpdateFrom } from "@/pages/trading/useIndicators";
import { toIndicatorCandles } from "@/pages/trading/utils";

/**
 * Bar Replay repaints the indicator series on every revealed bar. These tests
 * pin the invariant that makes that cheap: appending a bar never rewrites an
 * earlier one, so only the tail has to be re-applied.
 */

function series(count: number): CandlestickData<Time>[] {
  return Array.from({ length: count }, (_, i) => ({
    time: (1_700_000_000 + i * 60) as Time,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i * 0.5,
  }));
}

const points = (times: number[]) => times.map((time) => ({ time: time as Time, value: time }));

describe("incrementalUpdateFrom", () => {
  it("re-applies only the tail when bars are appended", () => {
    expect(incrementalUpdateFrom(points([1, 2, 3]), points([1, 2, 3, 4]))).toBe(2);
  });

  it("re-applies the last point when the bar count is unchanged (live bar)", () => {
    expect(incrementalUpdateFrom(points([1, 2, 3]), points([1, 2, 3]))).toBe(2);
  });

  it("asks for a full rewrite when the window moved", () => {
    // Seek / scroll: same length, different window.
    expect(incrementalUpdateFrom(points([1, 2, 3]), points([2, 3, 4]))).toBe(-1);
    // Stepping the replay cursor backwards reveals fewer bars.
    expect(incrementalUpdateFrom(points([1, 2, 3]), points([1, 2]))).toBe(-1);
    // Nothing was computed before (indicator just became active).
    expect(incrementalUpdateFrom([], points([1]))).toBe(-1);
    expect(incrementalUpdateFrom(points([1]), [])).toBe(-1);
  });
});

describe("indicator causality", () => {
  it("appending a bar never changes the earlier points", () => {
    const short = toIndicatorCandles(series(60));
    const long = toIndicatorCandles(series(61));

    const cases: Array<[string, (c: typeof short) => { time: number; value: number }[]]> = [
      ["SMA", (c) => sma(c, 14)],
      ["EMA", (c) => ema(c, 14)],
      ["RSI", (c) => rsi(c, 14)],
      ["VWAP", (c) => vwap(c)],
    ];

    for (const [name, compute] of cases) {
      const before = compute(short);
      const after = compute(long);
      expect(after.length, `${name} lost points`).toBeGreaterThanOrEqual(before.length);
      expect(after.slice(0, before.length), `${name} rewrote history`).toEqual(before);
    }
  });
});
