import type { Candle } from "../schemas.ts";
import { intervalMs, toExchangePair } from "./symbols.ts";
import {
  MarketSourceError,
  type CandleFetchResult,
  type CandleRangeRequest,
  type CandleSource,
} from "./types.ts";

/**
 * Exchange candle source — Binance's public klines endpoint.
 *
 * No API key and CORS-enabled, so the terminal can pull arbitrary historical
 * ranges straight from the browser. `data-api.binance.vision` is tried first
 * because it serves market data only; the numbered api hosts are fallbacks for
 * regions where the main host is blocked.
 */

const HOSTS: readonly string[] = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
];

const KLINES_PATH = "/api/v3/klines";
const TICKER_PATH = "/api/v3/ticker/bookTicker";

/** Binance caps a single klines response at 1000 rows. */
export const PAGE_LIMIT = 1000;

/** Hard ceiling on pages per request (1000 bars each) — keeps a bad range bounded. */
const MAX_PAGES = 120;

/** In-flight window requests. Enough to hide latency, gentle on rate limits. */
const FETCH_CONCURRENCY = 5;

/**
 * Global ceiling on simultaneous klines requests.
 *
 * Per-call concurrency is not enough: start-up fires several independent
 * consumers at once (first paint, the deep history load, seeding prices for
 * every symbol, and a replay snapshot), and their bursts add up. Letting that
 * through gets connections dropped, which surfaces as "Failed to fetch" rather
 * than as an HTTP status, so there is nothing to retry against.
 */
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waitingForSlot: Array<() => void> = [];

async function acquireRequestSlot(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waitingForSlot.push(resolve));
  inFlight += 1;
}

function releaseRequestSlot(): void {
  inFlight -= 1;
  waitingForSlot.shift()?.();
}

const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_500;

interface MsWindow {
  fromMs: number;
  toMs: number;
}

let activeHost: string | null = null;
let probeResult: boolean | null = null;

/** Hosts in preference order, with the last known-good host moved to the front. */
function hostsToTry(): string[] {
  if (!activeHost) return [...HOSTS];
  return [activeHost, ...HOSTS.filter((h) => h !== activeHost)];
}

/** Reset cached host/probe state. Test-only. */
export function resetExchangeStateForTests(): void {
  activeHost = null;
  probeResult = null;
  inFlight = 0;
  waitingForSlot.length = 0;
}

/** Errors worth retrying against a different host (geo blocks, rate limits, 5xx). */
function isRotatable(err: unknown): boolean {
  if (!(err instanceof MarketSourceError)) return false;
  if (err.kind === "network") return true;
  const status = err.status ?? 0;
  return status === 403 || status === 404 || status === 429 || status === 451 || status >= 500;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new MarketSourceError("http", `HTTP ${res.status} for ${url}`, res.status);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof MarketSourceError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new MarketSourceError("network", `${message} (${url})`);
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` against each candidate host until one succeeds. */
async function withHosts<T>(fn: (host: string) => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (const host of hostsToTry()) {
    try {
      const value = await fn(host);
      activeHost = host;
      return value;
    } catch (err) {
      lastError = err;
      if (!isRotatable(err)) throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new MarketSourceError("network", "No exchange host reachable");
}

interface KlinesQuery {
  startTime?: number;
  endTime?: number;
  limit: number;
}

function klinesUrl(host: string, pair: string, interval: string, query: KlinesQuery): string {
  const params = new URLSearchParams({
    symbol: pair,
    interval,
    limit: String(query.limit),
  });
  if (query.startTime !== undefined) params.set("startTime", String(query.startTime));
  if (query.endTime !== undefined) params.set("endTime", String(query.endTime));
  return `${host}${KLINES_PATH}?${params.toString()}`;
}

/** Map one raw Binance kline row to the terminal's Candle shape (seconds). */
function toCandle(row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const time = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  if (![time, open, high, low, close, volume].every((n) => Number.isFinite(n))) return null;
  return { time: Math.floor(time / 1000), open, high, low, close, volume };
}

/** Extra attempts for a page whose connection was dropped (not an HTTP error). */
const PAGE_RETRIES = 1;
const RETRY_DELAY_MS = 500;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchKlinesPage(
  pair: string,
  interval: string,
  query: KlinesQuery,
): Promise<Candle[]> {
  await acquireRequestSlot();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await withHosts((host) =>
          fetchJson<unknown[]>(klinesUrl(host, pair, interval, query), REQUEST_TIMEOUT_MS),
        );
        if (!Array.isArray(rows)) {
          throw new MarketSourceError("http", "Malformed klines response");
        }
        const out: Candle[] = [];
        for (const row of rows) {
          const candle = toCandle(row);
          if (candle) out.push(candle);
        }
        return out;
      } catch (err) {
        // Only a dropped connection is worth retrying: it is what a burst of
        // concurrent requests looks like from the browser.
        const retryable = err instanceof MarketSourceError && err.kind === "network";
        if (!retryable || attempt >= PAGE_RETRIES) throw err;
        await delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  } finally {
    releaseRequestSlot();
  }
}

/**
 * Tile [fromMs, toMs] into page-sized windows, newest first.
 *
 * Windows are independent of each other (each carries its own start/end), so
 * they can be fetched concurrently. That matters: a 12 000-bar deep load is 12
 * requests, and doing them one-by-one took ~15 s end to end.
 */
function tileWindows(fromMs: number, toMs: number, intervalLength: number, budget: number): MsWindow[] {
  const spanMs = toMs - fromMs + 1;
  const neededBySpan = Math.ceil(spanMs / (PAGE_LIMIT * intervalLength));
  const neededByBudget = Number.isFinite(budget) ? Math.ceil(budget / PAGE_LIMIT) : MAX_PAGES;
  const windowCount = Math.max(1, Math.min(MAX_PAGES, neededBySpan, Math.max(1, neededByBudget)));

  const windows: MsWindow[] = [];
  let cursorTo = toMs;
  while (windows.length < windowCount && cursorTo >= fromMs) {
    const cursorFrom = Math.max(fromMs, cursorTo - (PAGE_LIMIT - 1) * intervalLength);
    windows.push({ fromMs: cursorFrom, toMs: cursorTo });
    cursorTo = cursorFrom - 1;
  }
  return windows;
}

/**
 * Fetch an arbitrary candle range.
 *
 * The request is tiled into independent page-sized windows that are fetched
 * concurrently, newest window first. `maxBars` caps the returned bars; the
 * reported coverage never claims more than was actually verified, so the cache
 * knows to re-fetch whatever a truncated request left behind.
 */
async function fetchRange(req: CandleRangeRequest): Promise<CandleFetchResult> {
  const { symbol, timeframe, fromMs, toMs } = req;
  const pair = toExchangePair(symbol);
  const intervalLength = intervalMs(timeframe);

  if (toMs < fromMs) return { bars: [], coveredFromMs: toMs, coveredToMs: toMs };

  const budget = req.maxBars && req.maxBars > 0 ? req.maxBars : Number.POSITIVE_INFINITY;
  const windows = tileWindows(fromMs, toMs, intervalLength, budget);
  const tiledWholeRange = windows.length > 0 && windows[windows.length - 1]!.fromMs <= fromMs;

  const pages = await mapWithConcurrency(windows, FETCH_CONCURRENCY, (window) =>
    fetchKlinesPage(pair, timeframe, {
      startTime: window.fromMs,
      endTime: window.toMs,
      limit: PAGE_LIMIT,
    }),
  );

  const collected = new Map<number, Candle>();
  for (const page of pages) {
    for (const bar of page) collected.set(bar.time, bar);
  }
  const ascending = [...collected.values()].sort((a, b) => a.time - b.time);
  const bars =
    Number.isFinite(budget) && ascending.length > budget
      ? ascending.slice(ascending.length - budget)
      : ascending;

  const oldestKeptMs = bars[0] ? bars[0].time * 1000 : toMs;
  const coveredFromMs = tiledWholeRange && bars.length === ascending.length ? fromMs : oldestKeptMs;

  return { bars, coveredFromMs, coveredToMs: toMs };
}

/** Run `fn` over `items` with at most `limit` promises in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One tiny request to decide whether the exchange is usable from this browser. */
export async function probeExchange(): Promise<boolean> {
  if (probeResult !== null) return probeResult;
  try {
    const bars = await withHosts((host) =>
      fetchJson<unknown[]>(
        klinesUrl(host, "BTCUSDT", "1m", { limit: 1 }),
        PROBE_TIMEOUT_MS,
      ),
    );
    probeResult = Array.isArray(bars) && bars.length > 0;
  } catch {
    probeResult = false;
  }
  return probeResult;
}

export const binanceSource: CandleSource = {
  id: "exchange",
  fetchRange,
};

/**
 * Latest bid/ask for every mapped symbol in a single request. Used by the live
 * feed so the terminal's prices come from the same venue as its history.
 */
export async function fetchBookTickers(): Promise<Map<string, { bid: number; ask: number }>> {
  const rows = await withHosts((host) => fetchJson<unknown[]>(`${host}${TICKER_PATH}`, REQUEST_TIMEOUT_MS));
  const out = new Map<string, { bid: number; ask: number }>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as { symbol?: unknown; bidPrice?: unknown; askPrice?: unknown };
    if (typeof entry.symbol !== "string") continue;
    const bid = Number(entry.bidPrice);
    const ask = Number(entry.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) continue;
    out.set(entry.symbol, { bid, ask });
  }
  return out;
}
