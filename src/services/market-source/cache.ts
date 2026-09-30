import type { Candle } from "../schemas.ts";

/**
 * Per-series candle cache with range bookkeeping.
 *
 * Charts ask for many overlapping windows (first paint, deep history, scroll
 * back, and later Bar Replay snapshots). The cache records which sub-ranges have
 * already been *verified* by a source so overlapping requests only fetch the
 * genuinely missing head/tail instead of re-downloading the whole window.
 *
 * The source id is part of the cache key on purpose: bundled history is shifted
 * real data, so serving cached exchange bars next to bundled ones would put two
 * different price levels on one chart.
 */

/** Hard ceiling per series — roughly a month of 1m bars. */
const MAX_BARS_PER_SERIES = 120_000;

/** Covered intervals are merged; this only guards against pathological growth. */
const MAX_COVERED_INTERVALS = 64;

export interface MsInterval {
  fromMs: number;
  toMs: number;
}

interface Series {
  bars: Candle[];
  covered: MsInterval[];
}

/** Subtract `covered` from `pending`, returning the still-missing intervals. */
export function subtractIntervals(pending: MsInterval[], covered: MsInterval[]): MsInterval[] {
  let open = pending;
  for (const c of covered) {
    if (open.length === 0) break;
    const next: MsInterval[] = [];
    for (const p of open) {
      if (c.toMs < p.fromMs || c.fromMs > p.toMs) {
        next.push(p);
        continue;
      }
      if (c.fromMs > p.fromMs) next.push({ fromMs: p.fromMs, toMs: c.fromMs - 1 });
      if (c.toMs < p.toMs) next.push({ fromMs: c.toMs + 1, toMs: p.toMs });
    }
    open = next;
  }
  return open;
}

/** Sort and coalesce overlapping or adjacent intervals. */
export function mergeIntervals(list: MsInterval[]): MsInterval[] {
  const sorted = [...list].sort((a, b) => a.fromMs - b.fromMs);
  const out: MsInterval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.fromMs <= last.toMs + 1) {
      if (cur.toMs > last.toMs) last.toMs = cur.toMs;
      continue;
    }
    out.push({ fromMs: cur.fromMs, toMs: cur.toMs });
  }
  return out;
}

export function cacheKey(sourceId: string, symbol: string, timeframe: string): string {
  return `${sourceId}|${symbol}:${timeframe}`;
}

export class CandleCache {
  private series = new Map<string, Series>();

  /** Bars inside [fromMs, toMs], ascending by time. */
  slice(key: string, fromMs: number, toMs: number): Candle[] {
    const series = this.series.get(key);
    if (!series) return [];
    return series.bars.filter((b) => b.time * 1000 >= fromMs && b.time * 1000 <= toMs);
  }

  /** Oldest cached bar time in ms, or null when the series is empty. */
  oldestMs(key: string): number | null {
    const first = this.series.get(key)?.bars[0];
    return first ? first.time * 1000 : null;
  }

  /** Sub-ranges of [fromMs, toMs] that no source has verified yet. */
  gaps(key: string, fromMs: number, toMs: number): MsInterval[] {
    if (toMs < fromMs) return [];
    const series = this.series.get(key);
    if (!series) return [{ fromMs, toMs }];
    return subtractIntervals([{ fromMs, toMs }], series.covered);
  }

  /**
   * Store a fetched page. Bars are deduplicated by timestamp with the freshly
   * fetched value winning. Pass `covered: null` to keep bars without marking the
   * range verified — used for the bar that is still forming, which keeps changing.
   */
  merge(key: string, bars: Candle[], covered: MsInterval | null): void {
    let series = this.series.get(key);
    if (!series) {
      series = { bars: [], covered: [] };
      this.series.set(key, series);
    }

    if (bars.length > 0) {
      const byTime = new Map<number, Candle>();
      for (const b of series.bars) byTime.set(b.time, b);
      for (const b of bars) byTime.set(b.time, b);
      series.bars = [...byTime.values()].sort((a, b) => a.time - b.time);

      if (series.bars.length > MAX_BARS_PER_SERIES) {
        series.bars = series.bars.slice(series.bars.length - MAX_BARS_PER_SERIES);
        // Dropping the oldest bars invalidates any coverage below the new floor.
        const oldestMs = (series.bars[0]?.time ?? 0) * 1000;
        series.covered = series.covered
          .map((c) => ({ fromMs: Math.max(c.fromMs, oldestMs), toMs: c.toMs }))
          .filter((c) => c.fromMs <= c.toMs);
      }
    }

    const merged = mergeIntervals(covered ? [...series.covered, covered] : series.covered);
    series.covered =
      merged.length > MAX_COVERED_INTERVALS
        ? merged.slice(merged.length - MAX_COVERED_INTERVALS)
        : merged;
  }

  clear(): void {
    this.series.clear();
  }
}
