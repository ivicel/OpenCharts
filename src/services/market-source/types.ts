import type { Candle } from "../schemas.ts";

/**
 * Market-data source abstraction.
 *
 * OpenCharts used to ship only build-time OHLC that is time-shifted at runtime
 * so the newest bar lines up with "now" — enough for a live-feeling chart, but
 * useless for Bar Replay, which needs *arbitrary* historical ranges.
 *
 * Candle access therefore goes through this interface so the origin of the data
 * is a single decision point:
 *   - "exchange": a public exchange endpoint, real timestamps, any range;
 *   - "bundled":  the build-time dataset, used when the exchange is unreachable.
 *
 * The two must never be mixed inside one buffer: bundled history is shifted real
 * data, so blending it with exchange bars produces a visible price cliff.
 */

export type MarketSourceId = "exchange" | "bundled";

export interface CandleRangeRequest {
  symbol: string;
  timeframe: string;
  /** Inclusive lower bound, epoch milliseconds. */
  fromMs: number;
  /** Inclusive upper bound, epoch milliseconds. */
  toMs: number;
  /** Keep at most this many of the newest bars. */
  maxBars?: number;
}

export interface CandleFetchResult {
  /** Bars the source returned, ascending by time. May extend below `fromMs`. */
  bars: Candle[];
  /**
   * The part of the request the source actually verified. A paging loop that
   * hit its page cap reports a narrower range so the cache re-fetches the rest
   * instead of assuming the gap is empty.
   */
  coveredFromMs: number;
  coveredToMs: number;
}

export interface CandleSource {
  readonly id: MarketSourceId;
  fetchRange(req: CandleRangeRequest): Promise<CandleFetchResult>;
}

export type MarketSourceErrorKind = "unsupported" | "network" | "http";

export class MarketSourceError extends Error {
  readonly kind: MarketSourceErrorKind;
  readonly status: number | undefined;

  constructor(kind: MarketSourceErrorKind, message: string, status?: number) {
    super(message);
    this.name = "MarketSourceError";
    this.kind = kind;
    this.status = status;
  }
}

export interface MarketSourceStatus {
  id: MarketSourceId;
  /** True when the exchange is unavailable and bundled data is being served. */
  degraded: boolean;
  /** Last failure that caused — or would have caused — a fallback. */
  lastError: string | null;
}
