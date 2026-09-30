import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetExchangeStateForTests } from "@/services/market-source/binance";
import {
  getMarketFeedMode,
  resetMarketFeedModeForTests,
  setMarketFeedMode,
  subscribeMarketFeedMode,
} from "@/services/market-source/feed-status";
import { startExchangeTickerFeed, type BookTick } from "@/services/market-source/live";

function okJson(payload: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

describe("market feed mode", () => {
  beforeEach(() => {
    resetMarketFeedModeForTests();
  });

  it("starts out connecting", () => {
    expect(getMarketFeedMode()).toBe("connecting");
  });

  it("notifies subscribers only on real changes", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeMarketFeedMode((mode) => seen.push(mode));
    setMarketFeedMode("exchange");
    setMarketFeedMode("exchange");
    setMarketFeedMode("stale");
    expect(seen).toEqual(["exchange", "stale"]);
    unsubscribe();
    setMarketFeedMode("bundled");
    expect(seen).toEqual(["exchange", "stale"]);
  });
});

describe("exchange ticker feed", () => {
  beforeEach(() => {
    resetExchangeStateForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("maps book tickers onto display symbols", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          okJson([
            { symbol: "BTCUSDT", bidPrice: "100.5", askPrice: "101.5" },
            { symbol: "DOGEUSDT", bidPrice: "1", askPrice: "2" },
          ]),
        ),
      ),
    );

    const ticks: BookTick[] = [];
    const handle = startExchangeTickerFeed((tick) => ticks.push(tick), { pollMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);

    // Unmapped pairs are ignored; the rest are keyed by display symbol.
    expect(ticks).toEqual([{ symbol: "BTCUSD", bid: 100.5, ask: 101.5 }]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks).toHaveLength(2);
    handle.stop();
  });

  it("reports consecutive failures and recovers", async () => {
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        failing
          ? Promise.reject(new Error("network down"))
          : Promise.resolve(okJson([{ symbol: "ETHUSDT", bidPrice: "10", askPrice: "11" }])),
      ),
    );

    const failures: number[] = [];
    const successes: number[] = [];
    const handle = startExchangeTickerFeed(() => {}, {
      pollMs: 1_000,
      onFailure: (count) => failures.push(count),
      onSuccess: () => successes.push(1),
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failures).toEqual([1, 2, 3]);
    expect(successes).toHaveLength(0);

    failing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(successes).toHaveLength(1);
    expect(failures).toEqual([1, 2, 3]);

    handle.stop();
  });

  it("stops polling after stop()", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(okJson([{ symbol: "BTCUSDT", bidPrice: "1", askPrice: "2" }])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const handle = startExchangeTickerFeed(() => {}, { pollMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    handle.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
