import { MarketSourceError } from "./types.ts";

/**
 * Mapping between the terminal's display symbols / timeframes and the exchange
 * identifiers used by the public klines endpoint. Mirrors the pairs in
 * scripts/fetch-demo-data.mjs so live and bundled data describe the same market.
 */

const PAIR_BY_SYMBOL: Readonly<Record<string, string>> = {
  BTCUSD: "BTCUSDT",
  ETHUSD: "ETHUSDT",
  SOLUSD: "SOLUSDT",
  BNBUSD: "BNBUSDT",
  XRPUSD: "XRPUSDT",
  ADAUSD: "ADAUSDT",
};

/** Timeframe -> bar interval in milliseconds. Idential strings on Binance. */
export const INTERVAL_MS: Readonly<Record<string, number>> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

export function supportsSymbol(symbol: string): boolean {
  return symbol.toUpperCase() in PAIR_BY_SYMBOL;
}

export function supportsTimeframe(timeframe: string): boolean {
  return timeframe in INTERVAL_MS;
}

/** Display symbol -> exchange trading pair. Throws when unmapped. */
export function toExchangePair(symbol: string): string {
  const pair = PAIR_BY_SYMBOL[symbol.toUpperCase()];
  if (!pair) {
    throw new MarketSourceError("unsupported", `No exchange pair mapped for ${symbol}`);
  }
  return pair;
}

/** Exchange trading pair -> display symbol, or null when unknown. */
export function fromExchangePair(pair: string): string | null {
  const upper = pair.toUpperCase();
  for (const [symbol, mapped] of Object.entries(PAIR_BY_SYMBOL)) {
    if (mapped === upper) return symbol;
  }
  return null;
}

export function intervalMs(timeframe: string): number {
  const ms = INTERVAL_MS[timeframe];
  if (!ms) {
    throw new MarketSourceError("unsupported", `Unsupported timeframe ${timeframe}`);
  }
  return ms;
}

/** Start of the bar containing `atMs` — exchange bars are aligned to intervals. */
export function barStartMs(atMs: number, timeframe: string): number {
  return atMs - (atMs % intervalMs(timeframe));
}
