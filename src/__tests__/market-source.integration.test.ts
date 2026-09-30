import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetExchangeStateForTests } from "@/services/market-source/binance";
import { fetchBookTickers } from "@/services/market-source/binance";
import {
  getCandlesRange,
  getMarketSourceStatus,
  resetMarketSourceForTests,
} from "@/services/market-source/index";

/**
 * Live-endpoint checks. Skipped by default — run with:
 *
 *   VITE_RUN_NETWORK_TESTS=1 npx vitest run src/__tests__/market-source.integration.test.ts
 *
 * These exist because the mocked suites cannot catch URL/param mistakes or a
 * change in the exchange's response shape, and because the whole Bar Replay
 * feature depends on this endpoint actually answering.
 */
const describeNetwork = import.meta.env.VITE_RUN_NETWORK_TESTS === "1" ? describe : describe.skip;

const MIN = 60_000;

describeNetwork("exchange endpoints (network)", () => {
  beforeEach(() => {
    resetExchangeStateForTests();
    resetMarketSourceForTests();
  });

  afterEach(() => {
    resetMarketSourceForTests();
  });

  it("resolves the exchange as the active source", async () => {
    const now = Date.now();
    const bars = await getCandlesRange("BTCUSD", "1m", now - 10 * MIN, now);

    expect(getMarketSourceStatus().id).toBe("exchange");
    expect(getMarketSourceStatus().degraded).toBe(false);
    expect(bars.length).toBeGreaterThanOrEqual(5);

    for (let i = 1; i < bars.length; i++) {
      expect(bars[i]!.time).toBeGreaterThan(bars[i - 1]!.time);
    }
    const last = bars[bars.length - 1]!;
    expect(last.close).toBeGreaterThan(0);
    expect(last.high).toBeGreaterThanOrEqual(last.low);
    // Timestamps are seconds, within an hour of now.
    expect(Math.abs(last.time * 1000 - now)).toBeLessThan(3_600_000);
  });

  it("pages across multiple requests for a deep range", { timeout: 30_000 }, async () => {
    const now = Date.now();
    const bars = await getCandlesRange("ETHUSD", "15m", now - 3_000 * 15 * MIN, now);

    // The exchange caps a page at 1000 rows, so this must have paged (>1000).
    expect(bars.length).toBeGreaterThan(1_000);
    expect(bars.length).toBeLessThanOrEqual(3_001 + 1_000);
    expect(bars[0]!.time * 1000).toBeGreaterThanOrEqual(now - 3_001 * 15 * MIN);
  });

  it("serves overlapping windows from cache without refetching", async () => {
    const now = Date.now();
    const first = await getCandlesRange("BTCUSD", "5m", now - 500 * 5 * MIN, now);
    const second = await getCandlesRange("BTCUSD", "5m", now - 500 * 5 * MIN, now);
    expect(second.length).toBe(first.length);
    expect(second.map((b) => b.time)).toEqual(first.map((b) => b.time));
  });

  it("returns live bid/ask for the mapped symbols", async () => {
    const quotes = await fetchBookTickers();
    const btc = quotes.get("BTCUSDT");
    expect(btc).toBeDefined();
    expect(btc!.bid).toBeGreaterThan(0);
    expect(btc!.ask).toBeGreaterThanOrEqual(btc!.bid);
  });
});
