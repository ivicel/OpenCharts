import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as engine from "@/services/demo/engine";
import { useReplayJournalStore } from "@/pages/trading/bar-replay/replayJournal";

/**
 * Bar Replay trading: practice sessions must be fully isolated from the live
 * paper account, and stops must be matched against the replayed bar's range.
 */

function marketBuy(symbol = "BTCUSD", quantity = 1, extra: Record<string, number> = {}) {
  return engine.placeOrder({
    accountId: "demo",
    symbol,
    side: "BUY",
    type: "MARKET",
    quantity,
    ...extra,
  });
}

describe("paper engine replay sessions", () => {
  beforeEach(() => {
    // Each test starts from the live session, whichever one ran before. The
    // engine is a module singleton, so the live account is reset explicitly.
    engine.endReplaySession();
    engine.closeAllPositions();
  });

  afterEach(() => {
    engine.endReplaySession();
    useReplayJournalStore.getState().clear();
  });

  it("starts a practice session flat, with the live balance", () => {
    engine.mark("BTCUSD", 100);
    marketBuy();
    const liveBalance = engine.getAccount().balance;

    engine.startReplaySession({ balance: 50_000 });

    expect(engine.isReplaySessionActive()).toBe(true);
    expect(engine.getPositions()).toHaveLength(0);
    expect(engine.getAccount().balance).toBe(50_000);

    engine.endReplaySession();
    expect(engine.isReplaySessionActive()).toBe(false);
    expect(engine.getPositions()).toHaveLength(1);
    expect(engine.getAccount().balance).toBe(liveBalance);
  });

  it("fills a stop the replayed bar traded through", () => {
    engine.startReplaySession({ balance: 10_000 });
    engine.markBar("BTCUSD", { high: 100, low: 99, close: 100 });
    marketBuy("BTCUSD", 1, { stopLoss: 95 });
    expect(engine.getPositions()).toHaveLength(1);

    // The bar wicks below the stop before closing above it.
    engine.markBar("BTCUSD", { high: 101, low: 94, close: 96 });

    expect(engine.getPositions()).toHaveLength(0);
    const closed = engine.getClosedPositions()[0]!;
    expect(closed.exitPrice).toBe(95);
    expect(closed.realizedPnl).toBeCloseTo(-5);
  });

  it("ignores live ticks while a practice session is running", () => {
    engine.startReplaySession({ balance: 10_000 });
    engine.markBar("BTCUSD", { high: 100, low: 99, close: 100 });
    marketBuy();

    engine.mark("BTCUSD", 500);

    expect(engine.getPositions()[0]!.currentPrice).toBe(100);
    expect(engine.getLastPrice("BTCUSD")).toBe(100);
  });

  it("archives the session on exit, flattening what is still open", () => {
    const livePositions = engine.getPositions().length;
    const liveClosed = engine.getClosedPositions().length;

    engine.startReplaySession({ balance: 10_000 });
    engine.markBar("BTCUSD", { high: 100, low: 99, close: 100 });
    marketBuy("BTCUSD", 1);
    engine.markBar("BTCUSD", { high: 110, low: 105, close: 108 });

    const record = engine.endReplaySession()!;

    expect(record.tradeCount).toBe(1);
    expect(record.startingBalance).toBe(10_000);
    expect(record.closedPositions[0]!.exitPrice).toBe(108);
    expect(record.realizedPnl).toBeCloseTo(8);
    expect(record.endingBalance).toBeCloseTo(10_008);
    // Nothing leaks into the live account.
    expect(engine.getPositions()).toHaveLength(livePositions);
    expect(engine.getClosedPositions()).toHaveLength(liveClosed);
  });

  it("refuses to fill at a price that does not exist yet", () => {
    engine.startReplaySession({ balance: 10_000 });
    expect(() => marketBuy()).toThrow(/No price available/);
    expect(engine.getPositions()).toHaveLength(0);
  });

  it("refuses resting orders during replay (they would fill instantly at their own price)", () => {
    engine.startReplaySession({ balance: 10_000 });
    engine.markBar("BTCUSD", { high: 100, low: 99, close: 100 });
    expect(() =>
      engine.placeOrder({
        accountId: "demo",
        symbol: "BTCUSD",
        side: "BUY",
        type: "LIMIT",
        quantity: 1,
        price: 50,
      }),
    ).toThrow(/market orders/i);
    expect(engine.getPositions()).toHaveLength(0);
  });
});

describe("barStopExit", () => {
  it("returns the level a bar would have triggered", () => {
    const long = { side: "LONG", takeProfit: 120, stopLoss: 90 } as const;
    expect(engine.barStopExit(long, { high: 125, low: 95 })).toBe(120);
    expect(engine.barStopExit(long, { high: 110, low: 95 })).toBeNull();
    // A bar spanning both levels is read pessimistically: the stop came first.
    expect(engine.barStopExit(long, { high: 125, low: 85 })).toBe(90);
  });

  it("mirrors the logic for shorts", () => {
    const short = { side: "SHORT", takeProfit: 80, stopLoss: 110 } as const;
    expect(engine.barStopExit(short, { high: 105, low: 75 })).toBe(80);
    expect(engine.barStopExit(short, { high: 115, low: 75 })).toBe(110);
    expect(engine.barStopExit(short, { high: 105, low: 85 })).toBeNull();
  });

  it("ignores levels that were never set", () => {
    const bare = { side: "LONG", takeProfit: null, stopLoss: null } as const;
    expect(engine.barStopExit(bare, { high: 1e9, low: 0 })).toBeNull();
  });
});

describe("replay journal", () => {
  afterEach(() => {
    useReplayJournalStore.getState().clear();
  });

  it("keeps records across a reload", () => {
    useReplayJournalStore.getState().clear();
    const record = {
      id: "r1",
      label: "Replay session",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      startingBalance: 10_000,
      endingBalance: 10_120,
      realizedPnl: 120,
      tradeCount: 3,
      closedPositions: [],
      fills: [],
    };

    useReplayJournalStore.getState().add(record);

    expect(useReplayJournalStore.getState().records).toHaveLength(1);
    const stored: unknown = JSON.parse(localStorage.getItem("oc_replay_sessions") ?? "[]");
    expect(stored).toHaveLength(1);
  });
});
