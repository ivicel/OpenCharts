import { useEffect, useRef } from "react";
import { api } from "../../../services/api.ts";
import { endReplaySession, markBar, startReplaySession } from "../../../services/demo/engine.ts";
import { useTradingStore } from "../../../services/store.tsx";
import { toast } from "../../../services/toast.ts";
import { DEEP_CANDLE_LIMIT, TF_INTERVAL_MS } from "../constants.ts";
import { useReplayJournalStore } from "./replayJournal.ts";
import { useBarReplayStore, type BarReplayStatus } from "./replayStore.ts";

/**
 * Bar Replay runtime: snapshot loading, the playback clock and hotkeys.
 *
 * Mounted once by the trading page. Nothing here touches the live candle query —
 * replay renders from its own frozen snapshot, so real-time data can never leak
 * into a running session.
 */

/** Minimum gap between cursor repaints while playing (ms). */
const MIN_PAINT_MS = 80;

/** Bars advanced per repaint at "Max" speed. */
const MAX_BARS_PER_PAINT = 5;

/** Longest real gap folded into one clock step (tab switches, GC pauses). */
const MAX_FRAME_MS = 100;

/** Resolve the history snapshot for a session as soon as it starts. */
function useBarReplaySnapshot(): void {
  const status = useBarReplayStore((s) => s.status);
  const symbol = useBarReplayStore((s) => s.symbol);
  const timeframe = useBarReplayStore((s) => s.timeframe);
  const snapshotLoaded = useBarReplayStore((s) => s.snapshotLoaded);

  useEffect(() => {
    if (status !== "picking" || !symbol || !timeframe || snapshotLoaded) return;

    let cancelled = false;
    api
      .getCandles(symbol, timeframe, DEEP_CANDLE_LIMIT[timeframe])
      .then((bars) => {
        if (cancelled) return;
        const store = useBarReplayStore.getState();
        const snapshot = (bars ?? []).filter((bar) => Number.isFinite(bar.time));
        if (snapshot.length === 0) {
          store.setError(`No history available for ${symbol} ${timeframe}`);
          return;
        }
        store.setSnapshot(snapshot);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        useBarReplayStore
          .getState()
          .setError(err instanceof Error ? err.message : "Failed to load replay history");
      });

    return () => {
      cancelled = true;
    };
  }, [status, symbol, timeframe, snapshotLoaded]);
}

/**
 * Advance the cursor at `speed` × real time, one bar per timeframe interval.
 *
 * Repaints are throttled: without this, "Max" would re-slice the candle array
 * (and rebuild every indicator series) once per animation frame.
 */
function useBarReplayClock(): void {
  const status = useBarReplayStore((s) => s.status);
  const timeframe = useBarReplayStore((s) => s.timeframe);

  useEffect(() => {
    if (status !== "playing" || !timeframe) return;
    const intervalMs = TF_INTERVAL_MS[timeframe];

    let frameId = 0;
    let lastFrameAt = 0;
    let lastPaintAt = 0;
    let accumulatedMs = 0;

    const frame = (now: number): void => {
      const previous = lastFrameAt || now;
      lastFrameAt = now;
      const realDelta = Math.min(now - previous, MAX_FRAME_MS);
      const store = useBarReplayStore.getState();

      if (!Number.isFinite(store.speed)) {
        if (now - lastPaintAt >= MIN_PAINT_MS) {
          lastPaintAt = now;
          store.stepBy(MAX_BARS_PER_PAINT);
        }
      } else {
        accumulatedMs += realDelta * store.speed;
        if (now - lastPaintAt >= MIN_PAINT_MS) {
          const due = Math.floor(accumulatedMs / intervalMs);
          if (due > 0) {
            accumulatedMs -= due * intervalMs;
            lastPaintAt = now;
            store.stepBy(due);
          }
        }
      }

      frameId = requestAnimationFrame(frame);
    };

    frameId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameId);
  }, [status, timeframe]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** Shift+←/→ step, Space toggles playback. */
export function useBarReplayHotkeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const store = useBarReplayStore.getState();
      if (store.status === "off" || isTypingTarget(event.target)) return;

      if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        store.pause();
        store.stepBy(1);
        return;
      }
      if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        store.pause();
        store.stepBy(-1);
        return;
      }
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        if (store.status === "playing") store.pause();
        else store.play();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * Replay owns the whole price axis, not just the chart.
 *
 * The watchlist, DOM ladder and order ticket all read the same tick store, and
 * pricing an order off a live quote while the chart shows a historical bar
 * would be worse than useless. So while a session is open the live feed is
 * gated off (see MarketDataBridge) and the cursor bar's close is published as
 * the symbol's price instead.
 *
 * The same bar drives the paper engine, so a position opened mid-replay is
 * filled, marked and stopped out entirely at replay prices.
 */
function useBarReplayPriceFeed(): void {
  const status = useBarReplayStore((s) => s.status);
  const symbol = useBarReplayStore((s) => s.symbol);
  const bars = useBarReplayStore((s) => s.bars);
  const cursorIndex = useBarReplayStore((s) => s.cursorIndex);

  // Gate the live feed for exactly as long as a session is open.
  useEffect(() => {
    useTradingStore.getState().setLiveFeedSuppressed(status !== "off");
    return () => {
      useTradingStore.getState().setLiveFeedSuppressed(false);
    };
  }, [status]);

  useEffect(() => {
    if (status === "off" || !symbol) return;
    const bar = bars[cursorIndex];
    if (!bar) return;

    // Match stops against the bar's range first (a stop the bar traded through
    // must fill), then mark everything still open at the close.
    markBar(symbol, bar);

    // A tick-sized synthetic spread keeps bid/ask distinct without inventing a
    // market: everything is derived from the replayed bar's close.
    const half = Math.max(bar.close * 0.00005, 0.00001);
    useTradingStore
      .getState()
      .updateTick(symbol, bar.close - half, bar.close + half, bar.time * 1000);
  }, [status, symbol, bars, cursorIndex]);
}

/**
 * Swap the paper engine between the live account and a practice session.
 *
 * The practice session starts from the live balance with no positions, and its
 * trades are archived on exit — the live account is never touched, so a replay
 * can neither corrupt real paper trades nor be lost.
 */
function useReplayTradingSession(): void {
  const status = useBarReplayStore((s) => s.status);
  const previousStatusRef = useRef<BarReplayStatus>("off");

  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (previous === status) return;

    if (previous === "off" && status !== "off") {
      startReplaySession({ label: "Replay session" });
      return;
    }
    if (previous !== "off" && status === "off") {
      const record = endReplaySession();
      if (record && record.tradeCount > 0) {
        useReplayJournalStore.getState().add(record);
        const pnl = record.realizedPnl;
        toast.info(
          "Replay session saved",
          `${record.tradeCount} closed trade${record.tradeCount === 1 ? "" : "s"} · ${
            pnl >= 0 ? "+" : "-"
          }$${Math.abs(pnl).toFixed(2)}`,
        );
      }
    }
  }, [status]);
}

/** Mount once in the trading page. */
export function useBarReplay(): void {
  useBarReplaySnapshot();
  useBarReplayClock();
  useBarReplayHotkeys();
  useBarReplayPriceFeed();
  useReplayTradingSession();
}
