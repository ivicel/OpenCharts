import { publish } from "./bus.ts";
import { getTickPrices } from "./candles.ts";
import { mark } from "./engine.ts";
import { DEMO_SYMBOLS } from "./instruments.ts";
import { setMarketFeedMode } from "../market-source/feed-status.ts";
import {
  ensureMarketSource,
  getCandlesLatest,
  subscribeMarketSource,
} from "../market-source/index.ts";
import { startExchangeTickerFeed, type ExchangeTickerHandle } from "../market-source/live.ts";

/**
 * Market-data feed orchestrator.
 *
 * Live prices come from the same venue as the chart history: one `bookTicker`
 * poll per interval keeps every symbol's bid/ask fresh and drives the paper
 * engine's mark-to-market. When the exchange is unreachable at start-up, the
 * bundled 1m closes are replayed instead so the terminal still works fully
 * offline — the two modes are mutually exclusive by design.
 *
 * A *mid-session* outage never switches modes. Prices freeze at their last known
 * values (reported as "stale") instead of jumping to a different price level
 * underneath the user's open positions.
 */

/** Bundled replay cadence (one bundled 1m close per tick). */
const REPLAY_TICK_MS = 600;

/** Consecutive failed polls before live prices are reported as stale. */
const STALE_AFTER_FAILURES = 5;

type SymbolCursor = { symbol: string; prices: number[]; index: number; spread: number };

let replayTimer: ReturnType<typeof setInterval> | null = null;
let replayCursors: SymbolCursor[] = [];
let exchangeHandle: ExchangeTickerHandle | null = null;
let unsubscribeSource: (() => void) | null = null;
let started = false;

// ── Bundled replay (offline mode) ─────────────────────────

function buildCursors(): SymbolCursor[] {
  return DEMO_SYMBOLS.map((s) => {
    const prices = getTickPrices(s.name);
    const seed = prices[prices.length - 1] ?? 0;
    return { symbol: s.name, prices, index: 0, spread: Math.max(s.tickSize, seed * 0.0001) };
  });
}

function emitReplayTick(cursor: SymbolCursor): void {
  if (cursor.prices.length === 0) return;
  const price = cursor.prices[cursor.index]!;
  cursor.index = (cursor.index + 1) % cursor.prices.length;
  const half = cursor.spread / 2;
  publish("market-data", {
    eventType: "MarketTick",
    symbol: cursor.symbol,
    bid: price - half,
    ask: price + half,
    occurredAt: Date.now(),
  });
  mark(cursor.symbol, price);
}

function startBundledReplay(): void {
  stopExchangePolling();
  setMarketFeedMode("bundled");
  if (replayTimer) return;
  replayCursors = buildCursors();
  // Seed an initial price for every symbol so panels render immediately.
  for (const cursor of replayCursors) emitReplayTick(cursor);
  replayTimer = setInterval(() => {
    for (const cursor of replayCursors) emitReplayTick(cursor);
  }, REPLAY_TICK_MS);
}

function stopBundledReplay(): void {
  if (replayTimer) clearInterval(replayTimer);
  replayTimer = null;
}

// ── Exchange feed (default mode) ──────────────────────────

/**
 * Give the engine a real opening price before the first tick arrives, so an
 * order placed in the first few hundred milliseconds cannot price at zero.
 */
async function seedEngineFromHistory(): Promise<void> {
  await Promise.all(
    DEMO_SYMBOLS.map(async (symbol) => {
      try {
        const bars = await getCandlesLatest(symbol.name, "1m", 2);
        const last = bars[bars.length - 1];
        if (last) mark(symbol.name, last.close);
      } catch {
        // The first ticker poll seeds the price a moment later.
      }
    }),
  );
}

function emitExchangeTick(tick: { symbol: string; bid: number; ask: number }): void {
  publish("market-data", {
    eventType: "MarketTick",
    symbol: tick.symbol,
    bid: tick.bid,
    ask: tick.ask,
    occurredAt: Date.now(),
  });
  mark(tick.symbol, (tick.bid + tick.ask) / 2);
}

function startExchangePolling(): void {
  stopBundledReplay();
  if (exchangeHandle) return;
  exchangeHandle = startExchangeTickerFeed(emitExchangeTick, {
    onSuccess: () => setMarketFeedMode("exchange"),
    onFailure: (failures) => {
      if (failures >= STALE_AFTER_FAILURES) setMarketFeedMode("stale");
    },
  });
}

function stopExchangePolling(): void {
  exchangeHandle?.stop();
  exchangeHandle = null;
}

// ── Lifecycle ─────────────────────────────────────────────

async function boot(): Promise<void> {
  const source = await ensureMarketSource();
  if (!started) return;
  if (source.id !== "exchange") {
    startBundledReplay();
    return;
  }
  await seedEngineFromHistory();
  if (!started) return;
  startExchangePolling();
  // A start-up probe can succeed while the data requests are still blocked
  // (captive portals, region filtering) — follow the source if it degrades.
  unsubscribeSource = subscribeMarketSource((status) => {
    if (status.id === "bundled") startBundledReplay();
  });
}

export function startMarketFeed(): void {
  if (started) return;
  started = true;
  setMarketFeedMode("connecting");
  void boot();
}

export function stopMarketFeed(): void {
  started = false;
  stopBundledReplay();
  stopExchangePolling();
  unsubscribeSource?.();
  unsubscribeSource = null;
  setMarketFeedMode("connecting");
}
