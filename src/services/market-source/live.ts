import { fetchBookTickers } from "./binance.ts";
import { fromExchangePair } from "./symbols.ts";

/**
 * Exchange ticker feed.
 *
 * A single `bookTicker` request returns the best bid/ask for *every* symbol, so
 * the whole terminal can be kept live with one poll per interval — no websocket
 * reconnect state machine, and the same venue that serves the chart history.
 *
 * Polling is chained through `setTimeout` rather than `setInterval` so a slow
 * response can never stack up overlapping requests.
 */

export interface BookTick {
  symbol: string;
  bid: number;
  ask: number;
}

export interface ExchangeTickerOptions {
  /** Poll cadence in ms. */
  pollMs?: number;
  /** Called after each successful poll (useful to clear a "stale" flag). */
  onSuccess?: () => void;
  /** Called with the number of consecutive failed polls. */
  onFailure?: (consecutiveFailures: number) => void;
}

export interface ExchangeTickerHandle {
  stop(): void;
}

const DEFAULT_POLL_MS = 1_000;

export function startExchangeTickerFeed(
  onTick: (tick: BookTick) => void,
  options: ExchangeTickerOptions = {},
): ExchangeTickerHandle {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight = false;
  let consecutiveFailures = 0;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(run, pollMs);
  };

  const run = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    fetchBookTickers()
      .then((quotes) => {
        consecutiveFailures = 0;
        options.onSuccess?.();
        for (const [pair, quote] of quotes) {
          const symbol = fromExchangePair(pair);
          if (symbol) onTick({ symbol, bid: quote.bid, ask: quote.ask });
        }
      })
      .catch(() => {
        consecutiveFailures += 1;
        options.onFailure?.(consecutiveFailures);
      })
      .finally(() => {
        inFlight = false;
        schedule();
      });
  };

  run();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
