import { getHistory } from "../demo/candles.ts";
import type { CandleFetchResult, CandleRangeRequest, CandleSource } from "./types.ts";

/**
 * Offline candle source backed by the build-time dataset.
 *
 * The bundled series is real OHLC, but its timeline is shifted at load time so
 * the newest bar lines up with "now" (see services/demo/candles.ts). That makes
 * it a drop-in fallback for the chart, and an honest one for Bar Replay — the
 * replayable depth is simply the 1000 bars shipped per symbol/timeframe.
 *
 * Everything the bundled data can serve is reported as verified, so a session
 * that falls back to it never re-fetches: the dataset cannot change at runtime.
 */

async function fetchRange(req: CandleRangeRequest): Promise<CandleFetchResult> {
  const { symbol, timeframe, fromMs, toMs } = req;
  const bars = getHistory(symbol, timeframe);
  let inRange = bars.filter((b) => b.time * 1000 >= fromMs && b.time * 1000 <= toMs);
  if (req.maxBars && req.maxBars > 0 && inRange.length > req.maxBars) {
    inRange = inRange.slice(inRange.length - req.maxBars);
  }
  return { bars: inRange, coveredFromMs: fromMs, coveredToMs: toMs };
}

export const bundledSource: CandleSource = {
  id: "bundled",
  fetchRange,
};
