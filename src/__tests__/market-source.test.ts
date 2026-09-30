import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { binanceSource, resetExchangeStateForTests } from "@/services/market-source/binance";
import { CandleCache, mergeIntervals, subtractIntervals } from "@/services/market-source/cache";
import {
  getCandlesRange,
  getMarketSourceStatus,
  resetMarketSourceForTests,
  setMarketSourceForTests,
} from "@/services/market-source/index";
import {
  barStartMs,
  fromExchangePair,
  intervalMs,
  supportsSymbol,
  toExchangePair,
} from "@/services/market-source/symbols";
import { MarketSourceError, type CandleSource } from "@/services/market-source/types";
import type { Candle } from "@/services/schemas";

const MIN = 60_000;

function candle(timeMs: number, close = 100): Candle {
  return { time: Math.floor(timeMs / 1000), open: close, high: close, low: close, close, volume: 1 };
}

/** A raw Binance kline row. */
function klineRow(timeMs: number, close = 100): unknown[] {
  return [
    timeMs,
    String(close),
    String(close + 1),
    String(close - 1),
    String(close),
    "10",
    timeMs + MIN - 1,
    "0",
    0,
    "0",
    "0",
    "0",
  ];
}

function okJson(payload: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

describe("market-source symbols", () => {
  it("maps display symbols to exchange pairs", () => {
    expect(toExchangePair("BTCUSD")).toBe("BTCUSDT");
    expect(toExchangePair("xrpusd")).toBe("XRPUSDT");
    expect(fromExchangePair("ETHUSDT")).toBe("ETHUSD");
    expect(fromExchangePair("DOGEUSDT")).toBeNull();
    expect(supportsSymbol("ADAUSD")).toBe(true);
    expect(supportsSymbol("EURUSD")).toBe(false);
  });

  it("exposes interval lengths and aligns bars to them", () => {
    expect(intervalMs("1m")).toBe(MIN);
    expect(intervalMs("4h")).toBe(4 * 60 * MIN);
    expect(barStartMs(1_700_000_123_456, "1m") % MIN).toBe(0);
  });

  it("throws a typed error for unsupported input", () => {
    try {
      toExchangePair("EURUSD");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MarketSourceError);
      expect((err as MarketSourceError).kind).toBe("unsupported");
    }
    expect(() => intervalMs("2m")).toThrow(MarketSourceError);
  });
});

describe("candle cache range bookkeeping", () => {
  it("subtracts covered intervals from a pending range", () => {
    expect(subtractIntervals([{ fromMs: 0, toMs: 100 }], [{ fromMs: 20, toMs: 40 }])).toEqual([
      { fromMs: 0, toMs: 19 },
      { fromMs: 41, toMs: 100 },
    ]);
    expect(subtractIntervals([{ fromMs: 0, toMs: 100 }], [{ fromMs: 0, toMs: 100 }])).toEqual([]);
  });

  it("coalesces overlapping and adjacent intervals", () => {
    expect(
      mergeIntervals([
        { fromMs: 50, toMs: 60 },
        { fromMs: 0, toMs: 20 },
        { fromMs: 21, toMs: 49 },
      ]),
    ).toEqual([{ fromMs: 0, toMs: 60 }]);
  });

  it("only reports genuinely missing sub-ranges, per source", () => {
    const cache = new CandleCache();
    cache.merge("bundled|BTCUSD:1m", [candle(0)], { fromMs: 0, toMs: 10_000 });
    expect(cache.gaps("bundled|BTCUSD:1m", 0, 10_000)).toEqual([]);
    expect(cache.gaps("bundled|BTCUSD:1m", 0, 20_000)).toEqual([
      { fromMs: 10_001, toMs: 20_000 },
    ]);
    // A different source must not inherit the other's coverage.
    expect(cache.gaps("exchange|BTCUSD:1m", 0, 20_000)).toEqual([
      { fromMs: 0, toMs: 20_000 },
    ]);
  });

  it("deduplicates bars by timestamp, newest fetch winning", () => {
    const cache = new CandleCache();
    cache.merge("bundled|BTCUSD:1m", [candle(0, 100), candle(MIN, 100)], null);
    cache.merge("bundled|BTCUSD:1m", [candle(MIN, 250)], null);
    const bars = cache.slice("bundled|BTCUSD:1m", 0, 10 * MIN);
    expect(bars.map((b) => b.close)).toEqual([100, 250]);
  });

  it("keeps bars when coverage is not claimed", () => {
    const cache = new CandleCache();
    cache.merge("bundled|BTCUSD:1m", [candle(MIN)], null);
    expect(cache.slice("bundled|BTCUSD:1m", 0, 10 * MIN)).toHaveLength(1);
    expect(cache.gaps("bundled|BTCUSD:1m", 0, 10 * MIN)).toEqual([
      { fromMs: 0, toMs: 10 * MIN },
    ]);
  });
});

describe("binance source", () => {
  beforeEach(() => {
    resetExchangeStateForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pages backwards and returns ascending bars", async () => {
    // Exchange bars are interval-aligned; keep the fixture aligned too, since
    // unaligned synthetic rows would force a spurious extra page.
    const toMs = Math.floor(1_700_000_000_000 / MIN) * MIN;
    const requestedEnds: number[] = [];
    const fetchMock = vi.fn((url: string) => {
      const params = new URL(url).searchParams;
      const endTime = Number(params.get("endTime"));
      requestedEnds.push(endTime);
      const limit = Number(params.get("limit"));
      const newest = endTime - (endTime % MIN);
      // 1000 newest bars on the first page, 500 older ones afterwards.
      const count = requestedEnds.length === 1 ? limit : 500;
      const rows = Array.from({ length: count }, (_, i) =>
        klineRow(newest - i * MIN, 100 + i),
      );
      return Promise.resolve(okJson(rows));
    });
    vi.stubGlobal("fetch", fetchMock);

    const fromMs = toMs - 1499 * MIN;
    const result = await binanceSource.fetchRange({
      symbol: "BTCUSD",
      timeframe: "1m",
      fromMs,
      toMs,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedEnds[0]).toBe(toMs);
    expect(requestedEnds[1]).toBe(toMs - 1000 * MIN + MIN - 1);
    expect(result.bars).toHaveLength(1500);
    expect(result.coveredFromMs).toBe(fromMs);
    expect(result.coveredToMs).toBe(toMs);
    for (let i = 1; i < result.bars.length; i++) {
      expect(result.bars[i]!.time).toBeGreaterThan(result.bars[i - 1]!.time);
    }
  });

  it("stops at maxBars and reports only what it verified", async () => {
    const toMs = 1_700_000_000_000;
    const fetchMock = vi.fn((url: string) => {
      const params = new URL(url).searchParams;
      const endTime = Number(params.get("endTime"));
      const limit = Number(params.get("limit"));
      return Promise.resolve(
        okJson(Array.from({ length: limit }, (_, i) => klineRow(endTime - i * MIN))),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await binanceSource.fetchRange({
      symbol: "BTCUSD",
      timeframe: "1m",
      fromMs: toMs - 5000 * MIN,
      toMs,
      maxBars: 300,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.bars).toHaveLength(300);
    // The rest of the requested window was never verified.
    expect(result.coveredFromMs).toBe(toMs - 299 * MIN);
  });

  it("rotates to another host when one is blocked", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (new URL(url).host === "data-api.binance.vision") {
        return Promise.resolve({
          ok: false,
          status: 451,
          json: () => Promise.resolve(null),
        });
      }
      return Promise.resolve(okJson([klineRow(1_700_000_000_000)]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await binanceSource.fetchRange({
      symbol: "BTCUSD",
      timeframe: "1m",
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_000_000,
    });

    expect(result.bars).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects unsupported symbols", async () => {
    await expect(
      binanceSource.fetchRange({
        symbol: "EURUSD",
        timeframe: "1m",
        fromMs: 0,
        toMs: 1,
      }),
    ).rejects.toBeInstanceOf(MarketSourceError);
  });
});

describe("market-source facade", () => {
  beforeEach(() => {
    resetMarketSourceForTests();
  });

  afterEach(() => {
    resetMarketSourceForTests();
  });

  function countingSource(id: "exchange" | "bundled"): { source: CandleSource; calls: number[] } {
    const tracker = { source: null as unknown as CandleSource, calls: [] as number[] };
    tracker.source = {
      id,
      fetchRange: (req) => {
        tracker.calls.push(req.fromMs);
        const bars: Candle[] = [];
        for (let ms = req.fromMs; ms <= req.toMs; ms += MIN) bars.push(candle(ms));
        return Promise.resolve({ bars, coveredFromMs: req.fromMs, coveredToMs: req.toMs });
      },
    };
    return tracker;
  }

  it("serves overlapping closed ranges from cache", async () => {
    const tracker = countingSource("bundled");
    setMarketSourceForTests(tracker.source);

    // Bar timestamps are whole seconds, so keep the fixture interval-aligned.
    const toMs = Math.floor((Date.now() - 60 * MIN) / MIN) * MIN;
    const fromMs = toMs - 100 * MIN;
    await getCandlesRange("BTCUSD", "1m", fromMs, toMs);
    expect(tracker.calls).toHaveLength(1);

    await getCandlesRange("BTCUSD", "1m", fromMs, toMs);
    expect(tracker.calls).toHaveLength(1);

    // A wider window only fetches the missing head.
    const wider = fromMs - 50 * MIN;
    const bars = await getCandlesRange("BTCUSD", "1m", wider, toMs);
    expect(tracker.calls).toHaveLength(2);
    expect(tracker.calls[1]).toBe(wider);
    expect(bars).toHaveLength(151);
  });

  it("always refetches the bar that is still forming", async () => {
    const tracker = countingSource("bundled");
    setMarketSourceForTests(tracker.source);

    const toMs = Date.now();
    await getCandlesRange("BTCUSD", "1m", toMs - 10 * MIN, toMs);
    await getCandlesRange("BTCUSD", "1m", toMs - 10 * MIN, toMs);
    expect(tracker.calls).toHaveLength(2);
  });

  it("falls back to bundled history when the exchange fails", async () => {
    const failing: CandleSource = {
      id: "exchange",
      fetchRange: () => Promise.reject(new MarketSourceError("network", "offline")),
    };
    setMarketSourceForTests(failing);

    const now = Date.now();
    const bars = await getCandlesRange("BTCUSD", "1m", now - 30 * MIN, now);

    const status = getMarketSourceStatus();
    expect(status.degraded).toBe(true);
    expect(status.lastError).toContain("offline");
    // Bundled history is shifted so its newest bar is the current period.
    expect(bars.length).toBeGreaterThan(0);
  });

  it("freezes instead of switching sources once the exchange has served data", async () => {
    // A mid-session outage must not silently move the chart onto the bundled
    // timeline — that would be a price cliff underneath the user's positions.
    let failing = false;
    const source: CandleSource = {
      id: "exchange",
      fetchRange: (req) =>
        failing
          ? Promise.reject(new MarketSourceError("network", "down"))
          : Promise.resolve({
              bars: [candle(req.fromMs)],
              coveredFromMs: req.fromMs,
              coveredToMs: req.toMs,
            }),
    };
    setMarketSourceForTests(source);

    const toMs = Math.floor((Date.now() - 60 * MIN) / MIN) * MIN;
    await getCandlesRange("BTCUSD", "1m", toMs - 5 * MIN, toMs);
    expect(getMarketSourceStatus().degraded).toBe(false);

    failing = true;
    await expect(
      getCandlesRange("BTCUSD", "1m", toMs - 200 * MIN, toMs - 100 * MIN),
    ).rejects.toBeInstanceOf(MarketSourceError);
    expect(getMarketSourceStatus().degraded).toBe(false);
  });
});
