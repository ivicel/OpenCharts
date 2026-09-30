import type { Account, ClosedPosition, Fill, Order, Position } from "../schemas.ts";
import { publish } from "./bus.ts";
import { getDemoSymbol } from "./instruments.ts";

/**
 * In-browser paper-trading engine. The single source of truth for the demo
 * account, positions and orders. Market orders fill instantly at the latest
 * price; positions are marked-to-market on every tick. State is ephemeral
 * (memory only) — a refresh starts a fresh demo session.
 *
 * The engine runs one of two *sessions* at a time:
 *   - the live session, driven by exchange ticks (`mark`);
 *   - a Bar Replay session, driven by the replayed bar (`markBar`).
 *
 * Every exported function operates on whichever session is active, so the whole
 * terminal — positions, orders, equity, order ticket — follows replay without a
 * single UI change. Replay keeps the live account's id so id-keyed lookups
 * (active account, react-query keys, event routing) keep working; isolation
 * comes from the session's own position/order/fill arrays.
 */

const STARTING_BALANCE = 100_000;
const DEFAULT_LEVERAGE = 100;

interface EngineSession {
  account: Account;
  positions: Position[];
  orders: Order[];
  closed: ClosedPosition[];
  fills: Fill[];
  lastPrice: Map<string, number>;
}

function createSession(balance: number, label: string, id: string): EngineSession {
  const now = new Date().toISOString();
  return {
    account: {
      id,
      userId: "demo-user",
      templateId: "demo",
      label,
      status: "ACTIVE",
      balance,
      equity: balance,
      margin: 0,
      freeMargin: balance,
      phase: "LIVE",
      startDate: now,
      createdAt: now,
      updatedAt: now,
      isHftMode: false,
      template: { name: label, startingBalance: balance, instrumentType: "CRYPTO" },
    },
    positions: [],
    orders: [],
    closed: [],
    fills: [],
    lastPrice: new Map(),
  };
}

const LIVE_ACCOUNT_ID = crypto.randomUUID();
const liveSession = createSession(STARTING_BALANCE, "Demo Account", LIVE_ACCOUNT_ID);

let replaySession: EngineSession | null = null;
let active: EngineSession = liveSession;

// ── Reads ───────────────────────────────────────────────────

export function getAccount(): Account {
  return { ...active.account };
}
export function getAccounts(): Account[] {
  return [getAccount()];
}
export function getPositions(): Position[] {
  return active.positions.map((p) => ({ ...p }));
}
export function getOrders(): Order[] {
  return active.orders.map((o) => ({ ...o }));
}
export function getClosedPositions(): ClosedPosition[] {
  return active.closed.map((c) => ({ ...c }));
}
export function getFills(): Fill[] {
  return active.fills.map((f) => ({ ...f }));
}
export function getLastPrice(symbol: string): number {
  return active.lastPrice.get(symbol) ?? 0;
}
export function isReplaySessionActive(): boolean {
  return active !== liveSession;
}

// ── Replay session lifecycle ────────────────────────────────

export interface ReplaySessionRecord {
  id: string;
  label: string;
  startedAt: string;
  endedAt: string;
  startingBalance: number;
  endingBalance: number;
  realizedPnl: number;
  tradeCount: number;
  closedPositions: ClosedPosition[];
  fills: Fill[];
}

/**
 * Open a practice session that starts from the live account's balance but with
 * no positions or orders. The live session is left untouched: replay can never
 * corrupt real paper trades.
 */
export function startReplaySession(options: { balance?: number; label?: string } = {}): void {
  const balance = options.balance ?? liveSession.account.balance;
  replaySession = createSession(balance, options.label ?? "Replay session", LIVE_ACCOUNT_ID);
  active = replaySession;
  emitEquity();
}

/**
 * Close the replay session and hand back its record.
 *
 * Anything still open is flattened at the last replayed price first: carrying
 * replay positions into the live account would mark historical entries against
 * today's price and invent P&L out of nothing.
 */
export function endReplaySession(): ReplaySessionRecord | null {
  const session = replaySession;
  if (!session) return null;

  for (const position of [...session.positions]) {
    closePositionAtPrice(position.id, session.lastPrice.get(position.symbolName) ?? position.entryPrice);
  }

  const realizedPnl = session.closed.reduce((sum, c) => sum + c.realizedPnl, 0);
  const record: ReplaySessionRecord = {
    id: session.account.id + ":" + session.account.createdAt,
    label: session.account.label ?? "Replay session",
    startedAt: session.account.createdAt,
    endedAt: new Date().toISOString(),
    startingBalance: session.account.template?.startingBalance ?? session.account.balance,
    endingBalance: session.account.balance,
    realizedPnl,
    tradeCount: session.closed.length,
    closedPositions: session.closed.map((c) => ({ ...c })),
    fills: session.fills.map((f) => ({ ...f })),
  };

  replaySession = null;
  active = liveSession;
  // The UI was reading replay balances; publish the live ones straight away so
  // the account header cannot be left showing a practice balance.
  emitEquity();
  return record;
}

// ── Internals ───────────────────────────────────────────────

function notional(symbol: string, qty: number, price: number): number {
  const contractSize = getDemoSymbol(symbol)?.contractSize ?? 1;
  return price * qty * contractSize;
}

function pnlOf(pos: Position, price: number): number {
  const contractSize = getDemoSymbol(pos.symbolName)?.contractSize ?? 1;
  const dir = pos.side === "LONG" ? 1 : -1;
  return (price - pos.entryPrice) * pos.quantity * contractSize * dir;
}

function recomputeEquity(): void {
  let unrealized = 0;
  let margin = 0;
  for (const p of active.positions) {
    const price = active.lastPrice.get(p.symbolName) ?? p.entryPrice;
    p.currentPrice = price;
    p.unrealizedPnl = pnlOf(p, price);
    unrealized += p.unrealizedPnl;
    margin += p.margin;
  }
  active.account.margin = margin;
  active.account.equity = active.account.balance + unrealized;
  active.account.freeMargin = active.account.equity - margin;
  active.account.updatedAt = new Date().toISOString();
}

function emitEquity(): void {
  publish("account", {
    eventType: "EquityUpdated",
    accountId: active.account.id,
    equity: active.account.equity,
    balance: active.account.balance,
    freeMargin: active.account.freeMargin,
    marginUsed: active.account.margin,
  });
}

function openPosition(
  symbol: string,
  side: string,
  qty: number,
  price: number,
  tp?: number,
  sl?: number,
): Position {
  const isLong = side === "BUY";
  const pos: Position = {
    id: crypto.randomUUID(),
    accountId: active.account.id,
    symbolName: symbol,
    side: isLong ? "LONG" : "SHORT",
    quantity: qty,
    entryPrice: price,
    currentPrice: price,
    unrealizedPnl: 0,
    margin: notional(symbol, qty, price) / DEFAULT_LEVERAGE,
    contractSize: getDemoSymbol(symbol)?.contractSize ?? 1,
    openedAt: new Date().toISOString(),
    takeProfit: tp ?? null,
    stopLoss: sl ?? null,
  };
  active.positions.push(pos);
  publish("positions", {
    eventType: "PositionOpened",
    accountId: active.account.id,
    positionId: pos.id,
    _entity: { ...pos },
  });
  return pos;
}

function makeFilledOrder(input: PlaceOrderArgs, price: number): Order {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    accountId: active.account.id,
    symbolName: input.symbol,
    side: input.side === "BUY" ? "BUY" : "SELL",
    type: (input.type as Order["type"]) ?? "MARKET",
    quantity: input.quantity,
    price: input.price ?? null,
    stopPrice: input.stopPrice ?? null,
    takeProfit: input.takeProfit ?? null,
    stopLoss: input.stopLoss ?? null,
    status: "FILLED",
    filledQuantity: input.quantity,
    avgFillPrice: price,
    comment: null,
    createdAt: now,
    updatedAt: now,
  };
}

export type PlaceOrderArgs = {
  accountId: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
};

/** Market orders fill instantly at the latest price; an open position is created. */
export function placeOrder(input: PlaceOrderArgs): Order {
  const price = input.price ?? active.lastPrice.get(input.symbol) ?? 0;
  // Refuse rather than fill at zero: this can only happen before the first
  // price arrives (app start-up, or a replay whose starting bar is not picked
  // yet), and a zero-price fill would silently wreck the account.
  if (!(price > 0)) {
    throw new Error(`No price available for ${input.symbol} yet`);
  }
  // A replay has no resting-order book: `placeOrder` fills non-market orders
  // instantly at their own limit price, which during a replay would mean "buy
  // 50% below the market, get filled immediately". Until pending orders are
  // matched bar-by-bar, only market entries are allowed in a practice session.
  if (isReplaySessionActive() && (input.type ?? "MARKET").toUpperCase() !== "MARKET") {
    throw new Error("Only market orders are available during bar replay");
  }
  const order = makeFilledOrder(input, price);
  active.orders.unshift(order);
  publish("orders", {
    eventType: "OrderPlaced",
    accountId: active.account.id,
    orderId: order.id,
    _entity: { ...order },
  });
  publish("orders", {
    eventType: "OrderFilled",
    accountId: active.account.id,
    orderId: order.id,
    _entity: { ...order },
  });
  openPosition(input.symbol, input.side, input.quantity, price, input.takeProfit, input.stopLoss);
  recomputeEquity();
  emitEquity();
  return order;
}

function recordClose(pos: Position, qty: number, exitPrice: number, realized: number): void {
  const now = new Date().toISOString();
  active.closed.unshift({
    id: crypto.randomUUID(),
    accountId: active.account.id,
    symbolName: pos.symbolName,
    side: pos.side,
    quantity: qty,
    entryPrice: pos.entryPrice,
    exitPrice,
    realizedPnl: realized,
    commission: 0,
    swap: 0,
    openedAt: pos.openedAt,
    closedAt: now,
    isPartialClose: qty < pos.quantity,
  });
  active.fills.unshift({
    id: crypto.randomUUID(),
    orderId: pos.id,
    accountId: active.account.id,
    symbolName: pos.symbolName,
    side: pos.side === "LONG" ? "SELL" : "BUY",
    quantity: qty,
    price: exitPrice,
    commission: 0,
    realizedPnl: realized,
    createdAt: now,
  });
}

function closePositionAtPrice(
  positionId: string,
  price: number,
  quantity?: number,
): { success: boolean } {
  const idx = active.positions.findIndex((p) => p.id === positionId);
  if (idx < 0) return { success: false };
  const pos = active.positions[idx]!;
  const qty = quantity && quantity < pos.quantity ? quantity : pos.quantity;
  const realized = pnlOf({ ...pos, quantity: qty }, price);
  active.account.balance += realized;
  recordClose(pos, qty, price, realized);
  if (qty >= pos.quantity) {
    active.positions.splice(idx, 1);
    publish("positions", { eventType: "PositionClosed", accountId: active.account.id, positionId });
  } else {
    pos.quantity -= qty;
    publish("positions", {
      eventType: "PositionUpdated",
      accountId: active.account.id,
      positionId,
      quantity: pos.quantity,
    });
  }
  recomputeEquity();
  emitEquity();
  return { success: true };
}

export function closePosition(positionId: string, quantity?: number): { success: boolean } {
  const pos = active.positions.find((p) => p.id === positionId);
  if (!pos) return { success: false };
  const price = active.lastPrice.get(pos.symbolName) ?? pos.entryPrice;
  return closePositionAtPrice(positionId, price, quantity);
}

export function closeAllPositions(): { success: boolean } {
  for (const p of [...active.positions]) closePosition(p.id);
  return { success: true };
}

export function modifyPosition(
  positionId: string,
  mods: { takeProfit?: number | null; stopLoss?: number | null },
): Position | undefined {
  const pos = active.positions.find((p) => p.id === positionId);
  if (!pos) return undefined;
  if (mods.takeProfit !== undefined) pos.takeProfit = mods.takeProfit;
  if (mods.stopLoss !== undefined) pos.stopLoss = mods.stopLoss;
  publish("positions", {
    eventType: "PositionUpdated",
    accountId: active.account.id,
    positionId,
    unrealizedPnl: pos.unrealizedPnl,
    quantity: pos.quantity,
    averagePrice: pos.entryPrice,
  });
  return { ...pos };
}

export function cancelOrder(orderId: string): { success: boolean } {
  const idx = active.orders.findIndex((o) => o.id === orderId);
  if (idx >= 0) active.orders.splice(idx, 1);
  publish("orders", { eventType: "OrderCanceled", accountId: active.account.id, orderId });
  return { success: true };
}

function checkStops(pos: Position, price: number): boolean {
  const hitTp =
    pos.takeProfit != null && (pos.side === "LONG" ? price >= pos.takeProfit : price <= pos.takeProfit);
  const hitSl =
    pos.stopLoss != null && (pos.side === "LONG" ? price <= pos.stopLoss : price >= pos.stopLoss);
  return hitTp || hitSl;
}

/**
 * Level at which a bar's range would have triggered SL/TP, or null.
 *
 * When a single bar spans both levels the stop is assumed to have been hit
 * first — the conservative reading, and the only one that cannot flatter a
 * replay's P&L.
 */
export function barStopExit(
  pos: Pick<Position, "side" | "takeProfit" | "stopLoss">,
  bar: { high: number; low: number },
): number | null {
  const { takeProfit, stopLoss } = pos;
  if (pos.side === "LONG") {
    if (stopLoss != null && bar.low <= stopLoss) return stopLoss;
    if (takeProfit != null && bar.high >= takeProfit) return takeProfit;
    return null;
  }
  if (stopLoss != null && bar.high >= stopLoss) return stopLoss;
  if (takeProfit != null && bar.low <= takeProfit) return takeProfit;
  return null;
}

/**
 * Called by the live feed on every tick: marks positions, fires SL/TP.
 *
 * Ignored while a replay session is active — replay prices come from the
 * replayed bar (`markBar`), and letting a live tick through here would mark a
 * practice position at today's price.
 */
export function mark(symbol: string, price: number): void {
  if (active !== liveSession) return;
  lastPriceMark(symbol, price, false);
}

/**
 * Called by the replay clock for each revealed bar.
 *
 * Stops are matched against the bar's high/low rather than a single price, so a
 * stop the bar actually traded through is filled — which is what makes replay
 * practice behave like a backtest instead of like a snapshot.
 */
export function markBar(symbol: string, bar: { high: number; low: number; close: number }): void {
  active.lastPrice.set(symbol, bar.close);
  const affected = active.positions.filter((p) => p.symbolName === symbol);
  for (const pos of [...affected]) {
    const exit = barStopExit(pos, bar);
    if (exit !== null) closePositionAtPrice(pos.id, exit);
  }
  lastPriceMark(symbol, bar.close, true);
}

/** Mark every open position on `symbol` and publish the update. */
function lastPriceMark(symbol: string, price: number, force: boolean): void {
  active.lastPrice.set(symbol, price);
  const affected = active.positions.filter((p) => p.symbolName === symbol);
  if (affected.length === 0 && !force) return;
  for (const pos of affected) {
    if (checkStops(pos, price)) {
      closePosition(pos.id);
      continue;
    }
    pos.currentPrice = price;
    pos.unrealizedPnl = pnlOf(pos, price);
    publish("positions", {
      eventType: "PositionUpdated",
      accountId: active.account.id,
      positionId: pos.id,
      unrealizedPnl: pos.unrealizedPnl,
      quantity: pos.quantity,
      averagePrice: pos.entryPrice,
    });
  }
  recomputeEquity();
  emitEquity();
}
