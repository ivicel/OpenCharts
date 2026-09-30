import { useEffect, useRef } from "react";
import type { CandlestickData, IChartApi, ISeriesApi, Time } from "lightweight-charts";
import { LineStyle } from "lightweight-charts";
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
  stochastic,
  vwap,
  INDICATOR_REGISTRY,
  type IndicatorType,
} from "../../lib/indicators.ts";
import { toIndicatorCandles } from "./utils.ts";
import { CHART_COLORS } from "./constants.ts";

type LineSeries = ISeriesApi<"Line">;
type HistogramSeries = ISeriesApi<"Histogram">;
type AnySeries = LineSeries | HistogramSeries;
type LinePoint = { time: Time; value: number };
type HistogramPoint = { time: Time; value: number; color?: string };

/**
 * Index from which `next` has to be re-applied, or -1 when the series needs a
 * full `setData`.
 *
 * Every indicator here is causal — appending bars never changes the value of an
 * already-computed bar — so when the candle array is a pure extension of the
 * previous one, only the tail changed. That turns Bar Replay's per-bar repaint
 * from "recompute and re-upload everything" into a couple of `update()` calls,
 * which is the difference between a smooth replay and a stuttering one.
 */
export function incrementalUpdateFrom(
  previous: readonly { time: Time }[],
  next: readonly { time: Time }[],
): number {
  if (previous.length === 0 || next.length === 0) return -1;
  if (next.length < previous.length) return -1;
  // Both ends must line up, otherwise the window itself moved (seek, symbol
  // change, timeframe switch) and the whole series has to be rewritten.
  if (next[0]!.time !== previous[0]!.time) return -1;
  if (next[previous.length - 1]!.time !== previous[previous.length - 1]!.time) return -1;
  // Re-apply the last known point too: the newest bar keeps changing while live.
  return previous.length - 1;
}

export function useIndicators(
  chartRef: React.RefObject<IChartApi | null>,
  candleSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>,
  chartData: CandlestickData<Time>[],
  activeIndicators: IndicatorType[],
  isDark: boolean,
): void {
  const seriesRef = useRef<Map<string, AnySeries>>(new Map());
  const pointsRef = useRef<Map<string, { time: Time }[]>>(new Map());
  const signatureRef = useRef<string>("");
  const boundChartRef = useRef<IChartApi | null>(null);
  const colors = isDark ? CHART_COLORS.dark : CHART_COLORS.light;

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candleSeriesRef.current) return;

    // The chart instance is destroyed and recreated on theme/symbol changes, so
    // its old series are gone — never call removeSeries on the new chart with
    // them, and force a rebuild.
    const chartChanged = boundChartRef.current !== chart;
    boundChartRef.current = chart;

    const teardown = (): void => {
      if (!chartChanged) {
        for (const series of seriesRef.current.values()) {
          try {
            chart.removeSeries(series);
          } catch {
            /* already removed */
          }
        }
      }
      seriesRef.current.clear();
      pointsRef.current.clear();
    };

    // No candles (replay before a start point is picked, or a cold chart):
    // leaving the previous indicators up would show values for hidden bars.
    if (chartData.length === 0) {
      teardown();
      signatureRef.current = "";
      return;
    }

    const signature = `${activeIndicators.join(",")}|${isDark ? "dark" : "light"}`;
    const rebuild = chartChanged || signatureRef.current !== signature;
    if (rebuild) {
      teardown();
      signatureRef.current = signature;
    }

    const ensure = <T extends AnySeries>(key: string, create: () => T): T => {
      const existing = seriesRef.current.get(key);
      if (!rebuild && existing) return existing as T;
      const series = create();
      seriesRef.current.set(key, series);
      return series;
    };

    /** Apply recomputed points, updating only the tail when possible. */
    const applyLine = (key: string, series: LineSeries, points: LinePoint[]): void => {
      const previous = pointsRef.current.get(key);
      pointsRef.current.set(key, points);
      const from = rebuild ? -1 : incrementalUpdateFrom(previous ?? [], points);
      if (from >= 0) {
        for (let i = from; i < points.length; i++) series.update(points[i]!);
        return;
      }
      series.setData(points);
    };

    const applyHistogram = (
      key: string,
      series: HistogramSeries,
      points: HistogramPoint[],
    ): void => {
      const previous = pointsRef.current.get(key);
      pointsRef.current.set(key, points);
      const from = rebuild ? -1 : incrementalUpdateFrom(previous ?? [], points);
      if (from >= 0) {
        for (let i = from; i < points.length; i++) series.update(points[i]!);
        return;
      }
      series.setData(points);
    };

    const indCandles = toIndicatorCandles(chartData);

    for (const type of activeIndicators) {
      const config = INDICATOR_REGISTRY.find((r) => r.type === type);
      if (!config) continue;

      switch (type) {
        case "SMA": {
          const data = sma(indCandles, config.defaultParams.period!);
          const s = ensure("SMA", () =>
            chart.addLineSeries({ color: config.color, lineWidth: 1, priceScaleId: "right" }),
          );
          applyLine(
            "SMA",
            s,
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "EMA": {
          const data = ema(indCandles, config.defaultParams.period!);
          const s = ensure("EMA", () =>
            chart.addLineSeries({ color: config.color, lineWidth: 1, priceScaleId: "right" }),
          );
          applyLine(
            "EMA",
            s,
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "RSI": {
          const data = rsi(indCandles, config.defaultParams.period);
          const s = ensure("RSI", () =>
            chart.addLineSeries({ color: config.color, lineWidth: 1, priceScaleId: "rsi" }),
          );
          applyLine(
            "RSI",
            s,
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );

          const refHigh = ensure("RSI-70", () =>
            chart.addLineSeries({
              color: "#555",
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              priceScaleId: "rsi",
            }),
          );
          applyLine(
            "RSI-70",
            refHigh,
            data.map((p) => ({ time: p.time as Time, value: 70 })),
          );

          const refLow = ensure("RSI-30", () =>
            chart.addLineSeries({
              color: "#555",
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              priceScaleId: "rsi",
            }),
          );
          applyLine(
            "RSI-30",
            refLow,
            data.map((p) => ({ time: p.time as Time, value: 30 })),
          );
          break;
        }
        case "MACD": {
          const data = macd(
            indCandles,
            config.defaultParams.fast,
            config.defaultParams.slow,
            config.defaultParams.signal,
          );
          const mLine = ensure("MACD-line", () =>
            chart.addLineSeries({ color: "#2196f3", lineWidth: 1, priceScaleId: "macd" }),
          );
          applyLine(
            "MACD-line",
            mLine,
            data.macd.map((p) => ({ time: p.time as Time, value: p.value })),
          );

          const sLine = ensure("MACD-signal", () =>
            chart.addLineSeries({ color: "#ff9800", lineWidth: 1, priceScaleId: "macd" }),
          );
          applyLine(
            "MACD-signal",
            sLine,
            data.signal.map((p) => ({ time: p.time as Time, value: p.value })),
          );

          const histo = ensure("MACD-hist", () =>
            chart.addHistogramSeries({ priceScaleId: "macd" }),
          );
          applyHistogram(
            "MACD-hist",
            histo,
            data.histogram.map((p) => ({
              time: p.time as Time,
              value: p.value,
              color: p.value >= 0 ? colors.up + "99" : colors.down + "99",
            })),
          );
          break;
        }
        case "BOLL": {
          const data = bollingerBands(
            indCandles,
            config.defaultParams.period,
            config.defaultParams.stdDev,
          );
          const upper = ensure("BOLL-upper", () =>
            chart.addLineSeries({
              color: config.color + "80",
              lineWidth: 1,
              priceScaleId: "right",
            }),
          );
          applyLine(
            "BOLL-upper",
            upper,
            data.upper.map((p) => ({ time: p.time as Time, value: p.value })),
          );

          const mid = ensure("BOLL-mid", () =>
            chart.addLineSeries({ color: config.color, lineWidth: 1, priceScaleId: "right" }),
          );
          applyLine(
            "BOLL-mid",
            mid,
            data.middle.map((p) => ({ time: p.time as Time, value: p.value })),
          );

          const lower = ensure("BOLL-lower", () =>
            chart.addLineSeries({
              color: config.color + "80",
              lineWidth: 1,
              priceScaleId: "right",
            }),
          );
          applyLine(
            "BOLL-lower",
            lower,
            data.lower.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "ATR": {
          const data = atr(indCandles, config.defaultParams.period);
          const s = ensure("ATR", () =>
            chart.addLineSeries({ color: config.color, lineWidth: 1, priceScaleId: "atr" }),
          );
          applyLine(
            "ATR",
            s,
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "STOCH": {
          const data = stochastic(
            indCandles,
            config.defaultParams.kPeriod,
            config.defaultParams.dPeriod,
          );
          const kLine = ensure("STOCH-K", () =>
            chart.addLineSeries({ color: "#ab47bc", lineWidth: 1, priceScaleId: "stoch" }),
          );
          applyLine(
            "STOCH-K",
            kLine,
            data.k.map((p) => ({ time: p.time as Time, value: p.value })),
          );

          const dLine = ensure("STOCH-D", () =>
            chart.addLineSeries({ color: "#ff7043", lineWidth: 1, priceScaleId: "stoch" }),
          );
          applyLine(
            "STOCH-D",
            dLine,
            data.d.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
        case "VWAP": {
          const data = vwap(indCandles);
          const s = ensure("VWAP", () =>
            chart.addLineSeries({
              color: config.color,
              lineWidth: 2,
              lineStyle: LineStyle.Dashed,
              priceScaleId: "right",
            }),
          );
          applyLine(
            "VWAP",
            s,
            data.map((p) => ({ time: p.time as Time, value: p.value })),
          );
          break;
        }
      }
    }
    // chartRef/candleSeriesRef are stable refs; colors derived from isDark dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndicators, chartData, isDark]);
}
