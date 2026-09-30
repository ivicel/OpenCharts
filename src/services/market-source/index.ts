import type { Candle } from "../schemas.ts";
import { binanceSource, probeExchange } from "./binance.ts";
import { bundledSource } from "./bundled.ts";
import { CandleCache, cacheKey } from "./cache.ts";
import { intervalMs } from "./symbols.ts";
import { MarketSourceError, type CandleSource, type MarketSourceStatus } from "./types.ts";

/**
 * Candle access facade.
 *
 * Every OHLC consumer (chart history, scroll-back pagination, and Bar Replay)
 * goes through here, so the origin of market data is decided in exactly one
 * place:
 *   1. exchange — real timestamps, arbitrary historical ranges;
 *   2. bundled  — build-time history, used when the exchange is unreachable.
 *
 * Requests are served from a range-aware cache (see CandleCache), so overlapping
 * windows — first paint, then deep history, then replay snapshots — only fetch
 * the genuinely missing head/tail.
 *
 * Set `VITE_MARKET_SOURCE=bundled` to force offline mode.
 */

const cache = new CandleCache();

const exchangeEnabled = import.meta.env.VITE_MARKET_SOURCE !== "bundled";

let source: CandleSource | null = exchangeEnabled ? null : bundledSource;
let resolving: Promise<CandleSource> | null = null;
/** True once the exchange has served at least one request this session. */
let hadExchangeSuccess = false;
let status: MarketSourceStatus = {
  id: exchangeEnabled ? "exchange" : "bundled",
  degraded: !exchangeEnabled,
  lastError: null,
};

const listeners = new Set<(status: MarketSourceStatus) => void>();

function publish(next: Partial<MarketSourceStatus>): void {
  status = { ...status, ...next };
  for (const listener of listeners) listener(status);
}

export function getMarketSourceStatus(): MarketSourceStatus {
  return status;
}

/** Subscribe to source changes (drives the "offline data" badge). */
export function subscribeMarketSource(listener: (status: MarketSourceStatus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function resolveSource(): Promise<CandleSource> {
  if (source) return source;
  if (!resolving) {
    resolving = probeExchange()
      .then((reachable) => {
        source = reachable ? binanceSource : bundledSource;
        publish(
          reachable
            ? { id: "exchange", degraded: false, lastError: null }
            : {
                id: "bundled",
                degraded: true,
                lastError: "Exchange unreachable — serving bundled history",
              },
        );
        return source;
      })
      .finally(() => {
        resolving = null;
      });
  }
  return resolving;
}

/**
 * Resolve (and cache) the active source. The live feed calls this at start-up so
 * both the chart and the tick stream agree on which venue they are describing.
 */
export async function ensureMarketSource(): Promise<CandleSource> {
  return resolveSource();
}

/** Sticky per-session fallback: bundled data is the only remaining option. */
function degrade(err: unknown): void {
  source = bundledSource;
  publish({
    id: "bundled",
    degraded: true,
    lastError: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Only *closed* bars are cacheable. The bar currently forming changes on every
 * tick, so coverage stops just before it and the tail is refetched each call.
 */
function cacheableCoverageTo(intervalLength: number, requestedToMs: number): number {
  const now = Date.now();
  return Math.min(requestedToMs, now - (now % intervalLength) - 1);
}

async function fillGaps(
  src: CandleSource,
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
  maxBars: number | undefined,
): Promise<void> {
  const key = cacheKey(src.id, symbol, timeframe);
  const coverTo = cacheableCoverageTo(intervalMs(timeframe), toMs);

  for (const gap of cache.gaps(key, fromMs, toMs)) {
    const result = await src.fetchRange({
      symbol,
      timeframe,
      fromMs: gap.fromMs,
      toMs: gap.toMs,
      maxBars,
    });
    const coveredToMs = Math.min(result.coveredToMs, coverTo);
    cache.merge(
      key,
      result.bars,
      coveredToMs >= result.coveredFromMs
        ? { fromMs: result.coveredFromMs, toMs: coveredToMs }
        : null,
    );
  }
}

/**
 * Candles intersecting [fromMs, toMs], ascending. Falls back to bundled history
 * (once per session) when the exchange request fails.
 */
export async function getCandlesRange(
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
  maxBars?: number,
): Promise<Candle[]> {
  if (!(toMs >= fromMs)) return [];

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const src = await resolveSource();
    try {
      await fillGaps(src, symbol, timeframe, fromMs, toMs, maxBars);
      if (src.id === "exchange") hadExchangeSuccess = true;
      return cache.slice(cacheKey(src.id, symbol, timeframe), fromMs, toMs);
    } catch (err) {
      lastError = err;
      if (src.id !== "exchange") break;
      // Only fall back while the exchange has never served a request this
      // session. Once it has, a failure means "network is down": the caller
      // keeps its previous data and the tick feed freezes, instead of silently
      // jumping to the bundled timeline (which would be a ~100-day price cliff
      // in the middle of a session).
      if (hadExchangeSuccess) break;
      degrade(err);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new MarketSourceError("network", "Candle request failed");
}

/** The newest `limit` bars — the chart's normal history load. */
export async function getCandlesLatest(
  symbol: string,
  timeframe: string,
  limit: number,
): Promise<Candle[]> {
  const intervalLength = intervalMs(timeframe);
  const wanted = Math.max(1, Math.floor(limit));
  const toMs = Date.now();
  const fromMs = toMs - (wanted + 1) * intervalLength;
  const candles = await getCandlesRange(symbol, timeframe, fromMs, toMs, wanted + 1);
  return candles.length > wanted ? candles.slice(candles.length - wanted) : candles;
}

/** Test-only: pin the active source and skip probing. */
export function setMarketSourceForTests(next: CandleSource | null): void {
  source = next;
  resolving = null;
  cache.clear();
}

/** Test-only: restore idempotent module state. */
export function resetMarketSourceForTests(): void {
  source = exchangeEnabled ? null : bundledSource;
  resolving = null;
  hadExchangeSuccess = false;
  status = {
    id: exchangeEnabled ? "exchange" : "bundled",
    degraded: !exchangeEnabled,
    lastError: null,
  };
  cache.clear();
}
