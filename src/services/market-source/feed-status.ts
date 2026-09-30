/**
 * What is currently producing live prices.
 *
 * Kept separate from the candle-source status because the two answer different
 * questions: the candle source decides *where history comes from*, while this
 * describes the tick stream. Both are surfaced by the same UI badge.
 */

export type MarketFeedMode =
  /** Deciding between the exchange and the bundled replay. */
  | "connecting"
  /** Exchange book ticker. */
  | "exchange"
  /** Bundled replay feed (offline start-up). */
  | "bundled"
  /** Exchange feed is failing; the last known prices are held, not replaced. */
  | "stale";

let mode: MarketFeedMode = "connecting";
const listeners = new Set<(mode: MarketFeedMode) => void>();

export function getMarketFeedMode(): MarketFeedMode {
  return mode;
}

export function setMarketFeedMode(next: MarketFeedMode): void {
  if (mode === next) return;
  mode = next;
  for (const listener of listeners) listener(mode);
}

export function subscribeMarketFeedMode(listener: (mode: MarketFeedMode) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: restore the initial state. */
export function resetMarketFeedModeForTests(): void {
  mode = "connecting";
  listeners.clear();
}
